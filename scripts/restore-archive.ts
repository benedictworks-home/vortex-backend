#!/usr/bin/env tsx
/**
 * scripts/restore-archive.ts — Restore a cold-storage archive into a staging
 * schema (#413).
 *
 * Usage:
 *   tsx scripts/restore-archive.ts --date 2026-09-01 [--dry-run]
 *
 * Options:
 *   --date      YYYY-MM-DD partition to restore (required)
 *   --dry-run   Verify checksums and print row counts; do NOT write to Postgres
 *   --schema    Target Postgres schema (default: "archive_staging")
 *
 * Environment variables (same as the archival job):
 *   DATABASE_URL               Target Postgres connection string
 *   ARCHIVAL_BUCKET_NAME       S3 bucket name
 *   ARCHIVAL_S3_ENDPOINT       Optional MinIO endpoint
 *   ARCHIVAL_S3_REGION
 *   ARCHIVAL_S3_ACCESS_KEY_ID
 *   ARCHIVAL_S3_SECRET_ACCESS_KEY
 *   ARCHIVAL_PARTITION_PREFIX  Default: "date="
 *
 * What it does:
 *   1. Fetches the manifest.json for the date from S3.
 *   2. Downloads every Parquet file listed in the manifest.
 *   3. Verifies SHA-256 checksums.
 *   4. Reads intent rows from each Parquet file.
 *   5. Inserts them into `<schema>.intents` (a staging table, NOT the live schema).
 *   6. Prints a summary.
 *
 * The staging schema is created if it does not exist.  No FK constraints are
 * enforced during import because tokens may not exist in the staging schema.
 */

import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import {
  S3Client,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { readParquetFromBuffer } from "../src/archival/parquet-writer";

// ─── Argument parsing ─────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    date:     { type: "string" },
    "dry-run":{ type: "boolean", default: false },
    schema:   { type: "string", default: "archive_staging" },
  },
  strict: true,
});

const date = args.date;
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("ERROR: --date <YYYY-MM-DD> is required");
  process.exit(1);
}

const dryRun = args["dry-run"] ?? false;
const schema = args.schema ?? "archive_staging";

// ─── Config from env ──────────────────────────────────────────────────────────

const bucketName = process.env.ARCHIVAL_BUCKET_NAME ?? "vortex-archives";
const endpoint   = process.env.ARCHIVAL_S3_ENDPOINT ?? "";
const region     = process.env.ARCHIVAL_S3_REGION   ?? "us-east-1";
const accessKeyId     = process.env.ARCHIVAL_S3_ACCESS_KEY_ID ?? "";
const secretAccessKey = process.env.ARCHIVAL_S3_SECRET_ACCESS_KEY ?? "";
const partitionPrefix = process.env.ARCHIVAL_PARTITION_PREFIX ?? "date=";

// ─── S3 client ────────────────────────────────────────────────────────────────

const isMinIo = Boolean(endpoint);
const s3 = new S3Client({
  region,
  ...(isMinIo ? { endpoint, forcePathStyle: true } : {}),
  credentials: accessKeyId && secretAccessKey
    ? { accessKeyId, secretAccessKey }
    : undefined,
});

async function s3Get(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  const stream = res.Body as Readable;
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ─── Manifest types ───────────────────────────────────────────────────────────

interface ManifestFile {
  key: string;
  type: "intents" | "audit";
  rowCount: number;
  sha256: string;
  sizeBytes: number;
}

interface ArchivalManifest {
  date: string;
  archivedAt: string;
  files: ManifestFile[];
  totalIntentRows: number;
  totalAuditRows: number;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const manifestKey = `${partitionPrefix}${date}/manifest.json`;
  console.log(`\nRestore archive — date: ${date} | schema: ${schema} | dry-run: ${dryRun}`);
  console.log(`Fetching manifest: s3://${bucketName}/${manifestKey}\n`);

  // ── 1. Fetch & parse manifest ──────────────────────────────────────────────
  let manifest: ArchivalManifest;
  try {
    const raw = await s3Get(manifestKey);
    manifest = JSON.parse(raw.toString("utf-8")) as ArchivalManifest;
  } catch (err) {
    console.error(`ERROR: Could not fetch manifest — ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`Manifest: archived at ${manifest.archivedAt}`);
  console.log(`  Intent rows : ${manifest.totalIntentRows}`);
  console.log(`  Audit rows  : ${manifest.totalAuditRows}`);
  console.log(`  Files       : ${manifest.files.length}\n`);

  // ── 2. Download & verify all files ────────────────────────────────────────
  const fileBuffers = new Map<string, Buffer>();
  let checksumErrors = 0;

  for (const file of manifest.files) {
    process.stdout.write(`  Downloading ${file.key} ... `);
    const buf = await s3Get(file.key);
    const actual = sha256Hex(buf);

    if (actual !== file.sha256) {
      console.log(`CHECKSUM MISMATCH! expected=${file.sha256} actual=${actual}`);
      checksumErrors++;
    } else if (buf.length !== file.sizeBytes) {
      console.log(`SIZE MISMATCH! expected=${file.sizeBytes} actual=${buf.length}`);
      checksumErrors++;
    } else {
      console.log(`OK (${file.rowCount} rows, ${buf.length} bytes)`);
      fileBuffers.set(file.key, buf);
    }
  }

  if (checksumErrors > 0) {
    console.error(`\nERROR: ${checksumErrors} checksum mismatch(es). Aborting restore.`);
    process.exit(1);
  }

  console.log("\nAll checksums verified ✓");

  if (dryRun) {
    console.log("\nDry-run mode — no rows written to Postgres.");
    return;
  }

  // ── 3. Import into staging schema ─────────────────────────────────────────
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });

  try {
    await prisma.$connect();

    // Create staging schema + table if they don't exist.
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${schema}"."intents" (
        intent_id       TEXT PRIMARY KEY,
        user_addr       TEXT NOT NULL,
        src_chain       TEXT NOT NULL,
        src_token       TEXT,
        src_amount      TEXT,
        dst_token       TEXT,
        min_dst_amount  TEXT,
        fill_amount     TEXT,
        fee_amount      TEXT,
        solver          TEXT,
        state           TEXT NOT NULL,
        created_at      BIGINT,
        deadline        BIGINT,
        filled_at       BIGINT,
        slashed_at      BIGINT,
        slash_reason    TEXT,
        tx_hash         TEXT,
        version         INTEGER,
        src_verified    BOOLEAN,
        src_token_id    TEXT,
        dst_token_id    TEXT,
        src_decimals    INTEGER,
        dst_decimals    INTEGER,
        archived_from   TEXT DEFAULT '${date}'
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "${schema}"."intent_audit_log" (
        id          BIGINT PRIMARY KEY,
        intent_id   TEXT NOT NULL,
        timestamp   TEXT,
        to_state    TEXT,
        actor       TEXT,
        reason      TEXT,
        metadata    TEXT
      )
    `);

    let intentRowsImported = 0;
    let auditRowsImported = 0;

    for (const file of manifest.files) {
      const buf = fileBuffers.get(file.key)!;
      const rows = await readParquetFromBuffer(buf);

      if (file.type === "intents") {
        for (const r of rows) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "${schema}"."intents"
              (intent_id, user_addr, src_chain, src_token, src_amount,
               dst_token, min_dst_amount, fill_amount, fee_amount, solver,
               state, created_at, deadline, filled_at, slashed_at,
               slash_reason, tx_hash, version, src_verified,
               src_token_id, dst_token_id, src_decimals, dst_decimals)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
             ON CONFLICT (intent_id) DO NOTHING`,
            r.intent_id, r.user, r.src_chain,
            r.src_token, r.src_amount, r.dst_token, r.min_dst_amount,
            r.fill_amount ?? null, r.fee_amount ?? null, r.solver ?? null,
            r.state, r.created_at, r.deadline,
            r.filled_at ?? null, r.slashed_at ?? null,
            r.slash_reason ?? null, r.tx_hash ?? null,
            r.version, r.src_verified,
            r.src_token_id ?? null, r.dst_token_id ?? null,
            r.src_decimals ?? null, r.dst_decimals ?? null,
          );
          intentRowsImported++;
        }
      } else if (file.type === "audit") {
        for (const r of rows) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "${schema}"."intent_audit_log"
              (id, intent_id, timestamp, to_state, actor, reason, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (id) DO NOTHING`,
            r.id, r.intent_id, r.timestamp,
            r.to_state, r.actor, r.reason, r.metadata ?? null,
          );
          auditRowsImported++;
        }
      }
    }

    console.log(`\nRestore complete:`);
    console.log(`  Intent rows imported : ${intentRowsImported}`);
    console.log(`  Audit rows imported  : ${auditRowsImported}`);
    console.log(`  Target schema        : ${schema}`);
    console.log(`\nVerify with:`);
    console.log(`  psql $DATABASE_URL -c "SELECT COUNT(*) FROM \\"${schema}\\".intents;"`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Restore failed:", err);
  process.exit(1);
});

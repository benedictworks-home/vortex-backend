import { createHmac, timingSafeEqual } from "crypto";
import { BadRequestException } from "@nestjs/common";

/**
 * HMAC-signed, base64url-encoded opaque cursor codec (#412).
 *
 * A cursor encodes a keyset position `{ createdAt, id }` plus an optional
 * filter fingerprint that binds the cursor to the query that created it.
 * The HMAC signature prevents clients from crafting arbitrary cursors or
 * scanning rows outside their allowed filter set.
 *
 * Encoding format (before base64url):
 *   `<createdAt>:<id>:<filterHash>:<hmacHex>`
 *
 * where `filterHash` is a deterministic hex digest of the serialised filter
 * object (or empty string when no filter is applied).
 */
export interface CursorPayload {
  /** Unix epoch seconds — the primary sort key. */
  createdAt: number;
  /** Row UUID — the tie-breaker. */
  id: string;
  /** Opaque fingerprint that binds the cursor to a particular filter set. */
  filterHash: string;
}

const SEPARATOR = ":";

/**
 * Encode a cursor position into a signed, opaque base64url string.
 *
 * @param payload  The keyset position to encode.
 * @param secret   HMAC-SHA256 key.  Must be the same value for encode/decode.
 */
export function encodeCursor(payload: CursorPayload, secret: string): string {
  const body = [String(payload.createdAt), payload.id, payload.filterHash].join(SEPARATOR);
  const sig = hmac(secret, body);
  const raw = [body, sig].join(SEPARATOR);
  return toBase64Url(raw);
}

/**
 * Decode and verify a cursor string.
 *
 * @throws {BadRequestException} when the cursor is malformed, has an invalid
 *         signature, or belongs to a different filter set.
 */
export function decodeCursor(cursor: string, secret: string, expectedFilterHash: string): CursorPayload {
  let raw: string;
  try {
    raw = fromBase64Url(cursor);
  } catch {
    throw new BadRequestException("Invalid pagination cursor: malformed encoding");
  }

  const parts = raw.split(SEPARATOR);
  // body = createdAt:id:filterHash  →  3 parts + 1 sig = 4 parts minimum.
  // But id may contain hyphens (UUID), and filterHash is hex (no colons).
  // Split into at most 4 segments from the left so the HMAC (last segment)
  // is always isolated correctly even if future fields contain colons.
  if (parts.length < 4) {
    throw new BadRequestException("Invalid pagination cursor: unexpected format");
  }

  const sig = parts[parts.length - 1];
  const body = parts.slice(0, parts.length - 1).join(SEPARATOR);
  const expectedSig = hmac(secret, body);

  if (!timingSafeCompare(sig, expectedSig)) {
    throw new BadRequestException("Invalid pagination cursor: signature mismatch");
  }

  // Re-split just the body (3 fields, last is filterHash which is hex).
  const bodyParts = body.split(SEPARATOR);
  if (bodyParts.length < 3) {
    throw new BadRequestException("Invalid pagination cursor: missing fields");
  }

  const filterHash = bodyParts[bodyParts.length - 1];
  const id = bodyParts[bodyParts.length - 2];
  const createdAt = Number(bodyParts[bodyParts.length - 3]);

  if (!Number.isInteger(createdAt) || createdAt <= 0) {
    throw new BadRequestException("Invalid pagination cursor: invalid createdAt");
  }

  if (filterHash !== expectedFilterHash) {
    throw new BadRequestException(
      "Pagination cursor belongs to a different filter set; start a new page scan",
    );
  }

  return { createdAt, id, filterHash };
}

/**
 * Produce a deterministic hex fingerprint for a filter object.
 * Keys are sorted so `{ a:1, b:2 }` and `{ b:2, a:1 }` produce the same hash.
 */
export function hashFilter(filter: Record<string, unknown>): string {
  const sorted = Object.keys(filter)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      const v = filter[k];
      if (v !== undefined && v !== null) {
        acc[k] = v;
      }
      return acc;
    }, {});
  return hmac("filter-hash-static-key", JSON.stringify(sorted)).slice(0, 16);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hmac(key: string, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

function toBase64Url(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function fromBase64Url(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(pad), "base64").toString("utf8");
}

/** Constant-time string comparison. */
function timingSafeCompare(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

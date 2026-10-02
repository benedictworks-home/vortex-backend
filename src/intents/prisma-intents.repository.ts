import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  IIntentsRepository,
  IdempotentCreateResult,
  IntentPatch,
  MutationResult,
  VersionConflict,
} from "./intents.repository";
import { Intent, IntentState, TokenInfo, StellarToken } from "./intents.types";

// ─── Row → domain mappers ─────────────────────────────────────────────────────

type IntentRow = {
  id: string;
  intentId: string;
  user: string;
  srcChain: string;
  srcToken: Prisma.JsonValue;
  srcAmount: string;
  dstToken: Prisma.JsonValue;
  minDstAmount: string;
  quotedDstAmount?: string | null;
  acceptedDstAmount?: string | null;
  solver?: string | null;
  state: string;
  createdAt: number;
  deadline: number;
  filledAt?: number | null;
  fillAmount?: string | null;
  feeAmount?: string | null;
  txHash?: string | null;
  slashedAt?: number | null;
  slashReason?: string | null;
  version: number;
  idempotencyKey?: string | null;
  auction?: Prisma.JsonValue | null;
  srcVerified: boolean;
  srcTxHash?: string | null;
  srcVerification?: Prisma.JsonValue | null;
  paramsVersion?: string | null;
  // #410 FK columns
  srcTokenId?: string | null;
  dstTokenId?: string | null;
  srcDecimals?: number | null;
  dstDecimals?: number | null;
};

function rowToIntent(row: IntentRow): Intent {
  return {
    intentId: row.intentId,
    user: row.user,
    srcChain: row.srcChain as Intent["srcChain"],
    srcToken: row.srcToken as unknown as TokenInfo,
    srcAmount: row.srcAmount,
    dstToken: row.dstToken as unknown as StellarToken,
    minDstAmount: row.minDstAmount,
    quotedDstAmount: row.quotedDstAmount ?? undefined,
    acceptedDstAmount: row.acceptedDstAmount ?? undefined,
    solver: row.solver ?? undefined,
    state: row.state as IntentState,
    createdAt: row.createdAt,
    deadline: row.deadline,
    filledAt: row.filledAt ?? undefined,
    fillAmount: row.fillAmount ?? undefined,
    feeAmount: row.feeAmount ?? undefined,
    txHash: row.txHash ?? undefined,
    slashedAt: row.slashedAt ?? undefined,
    slashReason: row.slashReason ?? undefined,
    version: row.version,
    auction: row.auction as Record<string, unknown> | undefined,
    srcVerified: row.srcVerified,
    srcTxHash: row.srcTxHash ?? undefined,
    srcVerification: row.srcVerification as Intent["srcVerification"],
    paramsVersion: row.paramsVersion ?? undefined,
    srcTokenId: row.srcTokenId ?? undefined,
    dstTokenId: row.dstTokenId ?? undefined,
    srcDecimals: row.srcDecimals ?? undefined,
    dstDecimals: row.dstDecimals ?? undefined,
  };
}

function intentToCreateData(intent: Intent): Record<string, unknown> {
  return {
    id: intent.intentId,     // use intentId as Prisma id for upsert simplicity
    intentId: intent.intentId,
    user: intent.user,
    srcChain: intent.srcChain as string,
    srcToken: intent.srcToken as unknown,
    srcAmount: intent.srcAmount,
    dstToken: intent.dstToken as unknown,
    minDstAmount: intent.minDstAmount,
    quotedDstAmount: intent.quotedDstAmount ?? null,
    acceptedDstAmount: intent.acceptedDstAmount ?? null,
    solver: intent.solver ?? null,
    state: intent.state as string,
    createdAt: intent.createdAt,
    deadline: intent.deadline,
    filledAt: intent.filledAt ?? null,
    fillAmount: intent.fillAmount ?? null,
    feeAmount: intent.feeAmount ?? null,
    txHash: intent.txHash ?? null,
    slashedAt: intent.slashedAt ?? null,
    slashReason: intent.slashReason ?? null,
    version: intent.version,
    idempotencyKey: intent.intentId, // use intentId as idempotency default
    auction: intent.auction ?? null,
    srcVerified: intent.srcVerified,
    srcTxHash: intent.srcTxHash ?? null,
    srcVerification: intent.srcVerification ?? null,
    paramsVersion: intent.paramsVersion ?? null,
    srcTokenId: intent.srcTokenId ?? null,
    dstTokenId: intent.dstTokenId ?? null,
    srcDecimals: intent.srcDecimals ?? null,
    dstDecimals: intent.dstDecimals ?? null,
  };
}

// ─── Repository ───────────────────────────────────────────────────────────────

/**
 * Prisma-backed implementation of IIntentsRepository (#404 / #405 / #410).
 *
 * Optimistic concurrency is enforced via `WHERE version = $expected` predicates
 * in raw UPDATE statements for all guarded transitions so they remain atomic
 * under concurrent load.
 *
 * Issue #410: `save()` attempts to populate srcTokenId / dstTokenId / snapshot
 * decimals by joining against the tokens table using (address, chain).  If the
 * token is not in the registry the FK columns are left null — the JSON blob
 * path remains valid.
 */
@Injectable()
export class PrismaIntentsRepository implements IIntentsRepository {
  private readonly logger = new Logger(PrismaIntentsRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Read methods ──────────────────────────────────────────────────────────

  async findById(id: string): Promise<Intent | undefined> {
    const row = await this.prisma.intent.findUnique({ where: { intentId: id } });
    return row ? rowToIntent(row as IntentRow) : undefined;
  }

  async findAll(): Promise<Intent[]> {
    const rows = await this.prisma.intent.findMany({
      orderBy: [{ createdAt: "desc" }, { intentId: "asc" }],
    });
    return rows.map((r) => rowToIntent(r as IntentRow));
  }

  async findByState(state: IntentState): Promise<Intent[]> {
    const rows = await this.prisma.intent.findMany({
      where: { state: state as string },
      orderBy: [{ createdAt: "desc" }, { intentId: "asc" }],
    });
    return rows.map((r) => rowToIntent(r as IntentRow));
  }

  async findByUser(user: string): Promise<Intent[]> {
    const rows = await this.prisma.intent.findMany({
      where: { user: { equals: user, mode: "insensitive" } },
      orderBy: [{ createdAt: "desc" }, { intentId: "asc" }],
    });
    return rows.map((r) => rowToIntent(r as IntentRow));
  }

  async findManyByIds(ids: string[]): Promise<Intent[]> {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    const rows = await this.prisma.intent.findMany({
      where: { intentId: { in: unique } },
    });
    return rows.map((r) => rowToIntent(r as IntentRow));
  }

  async countAcceptedBySolver(solver: string): Promise<number> {
    return this.prisma.intent.count({
      where: { solver: { equals: solver, mode: "insensitive" }, state: "accepted" as string },
    });
  }

  async countActiveByUser(user: string): Promise<number> {
    return this.prisma.intent.count({
      where: {
        user: { equals: user, mode: "insensitive" },
        state: { in: ["open", "accepted"] as string[] },
      },
    });
  }

  findByIdempotencyKey(key: string, minCreatedAt: number): Promise<Intent | undefined> {
    return this.prisma.intent
      .findFirst({
        where: { idempotencyKey: key, createdAt: { gte: minCreatedAt } },
      })
      .then((row) => (row ? rowToIntent(row as IntentRow) : undefined));
  }

  // ── Write methods ─────────────────────────────────────────────────────────

  /**
   * Save (upsert) an intent.  Attempts to resolve token FK columns (#410)
   * when `srcTokenId` / `dstTokenId` are not already set.
   */
  async save(intent: Intent): Promise<Intent> {
    const withFk = await this.resolveTokenFks(intent);
    const data = intentToCreateData(withFk);
    const row = await this.prisma.intent.upsert({
      where: { intentId: intent.intentId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: data as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: (({ id: _id, ...rest }) => rest)(data) as any,
    });
    return rowToIntent(row as IntentRow);
  }

  /**
   * Version-guarded upsert for the dual-write mirror.
   * Saves only when incoming version >= stored version.
   */
  async saveIfNewer(intent: Intent): Promise<Intent> {
    const existing = await this.findById(intent.intentId);
    if (existing && existing.version > intent.version) return existing;
    return this.save(intent);
  }

  async createIdempotent(
    intent: Intent,
    idempotencyKey: string,
    minCreatedAt: number,
  ): Promise<IdempotentCreateResult> {
    // Check for existing key first (read-before-write is safe here because the
    // UNIQUE constraint on idempotency_key makes the INSERT below atomic).
    const existing = await this.findByIdempotencyKey(idempotencyKey, minCreatedAt);
    if (existing) return { intent: existing, created: false };

    const withFk = await this.resolveTokenFks(intent);
    const data = intentToCreateData(withFk);
    // Override the idempotency key with the caller-supplied one.
    data.idempotencyKey = idempotencyKey;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await this.prisma.intent.create({ data: data as any });
      return { intent: rowToIntent(row as IntentRow), created: true };
    } catch (err) {
      // Unique constraint violation → another replica created first.
      if ((err as { code?: string }).code === "P2002") {
        const replay = await this.findByIdempotencyKey(idempotencyKey, minCreatedAt);
        if (replay) return { intent: replay, created: false };
      }
      throw err;
    }
  }

  async update(id: string, patch: IntentPatch, expectedVersion: number): Promise<MutationResult> {
    return this.prisma.withDefaultTimeout(async (tx) => {
      const existing = await (tx as unknown as typeof this.prisma).intent.findUnique({
        where: { intentId: id },
      });
      if (!existing) return null;
      const current = existing as IntentRow;
      if (current.version !== expectedVersion) {
        return new VersionConflict(id, expectedVersion, current.version);
      }
      const updated = await (tx as unknown as typeof this.prisma).intent.update({
        where: { intentId: id, version: expectedVersion },
        data: { ...(patch as Record<string, unknown>), version: expectedVersion + 1 },
      });
      return updated ? rowToIntent(updated as IntentRow) : null;
    });
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.prisma.intent.delete({ where: { intentId: id } });
      return true;
    } catch {
      return false;
    }
  }

  // ── Atomic transitions ────────────────────────────────────────────────────

  async acceptIfOpen(
    id: string,
    solver: string,
    newDeadline: number,
    now?: number,
    expectedVersion?: number,
  ): Promise<MutationResult> {
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    return this.prisma.withDefaultTimeout(async (tx) => {
      const existing = await (tx as unknown as typeof this.prisma).intent.findUnique({
        where: { intentId: id },
      });
      if (!existing) return null;
      const row = existing as IntentRow;
      if (row.state !== "open" || row.deadline <= nowSec) return null;
      if (expectedVersion !== undefined && row.version !== expectedVersion) {
        return new VersionConflict(id, expectedVersion, row.version);
      }
      const updated = await (tx as unknown as typeof this.prisma).intent.updateMany({
        where: {
          intentId: id,
          state: "open",
          deadline: { gt: nowSec },
          version: row.version,
        },
        data: {
          state: "accepted",
          solver,
          deadline: newDeadline,
          version: row.version + 1,
        },
      });
      if (updated.count === 0) return null;
      return rowToIntent({ ...row, state: "accepted", solver, deadline: newDeadline, version: row.version + 1 });
    });
  }

  async acceptIfOpenWithinExposure(
    id: string,
    solver: string,
    newDeadline: number,
    now: number,
    candidateExposureUsdMicros: bigint,
    maxExposureUsdMicros: bigint,
  ): Promise<{ intent: Intent | null; exposureExceeded: boolean }> {
    // Serialise per-solver using a Postgres advisory lock so only one
    // concurrent request can evaluate the exposure cap for a given solver.
    const lockKey = this.solverAdvisoryLockKey(solver);
    return this.prisma.withDefaultTimeout(async (tx) => {
      const rawTx = tx as unknown as { $executeRaw: typeof this.prisma.$executeRaw };
      await rawTx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      const existing = await (tx as unknown as typeof this.prisma).intent.findUnique({
        where: { intentId: id },
      });
      if (!existing) return { intent: null, exposureExceeded: false };
      const row = existing as IntentRow;
      if (row.state !== "open" || row.deadline <= now) {
        return { intent: null, exposureExceeded: false };
      }

      // Sum exposure for accepted intents belonging to this solver.
      // srcAmount is TEXT — cast to NUMERIC for SUM via raw query.
      const rawResult = await (tx as unknown as typeof this.prisma).$queryRaw<Array<{ total: string | null }>>`
        SELECT COALESCE(SUM(src_amount::numeric)::text, '0') AS total
        FROM intents
        WHERE LOWER(solver) = LOWER(${solver})
          AND state = 'accepted'
          AND deadline > ${now}
      `;
      const acceptedExposure = BigInt(rawResult[0]?.total ?? "0");

      if (acceptedExposure + candidateExposureUsdMicros > maxExposureUsdMicros) {
        return { intent: null, exposureExceeded: true };
      }

      const updated = await (tx as unknown as typeof this.prisma).intent.updateMany({
        where: { intentId: id, state: "open", version: row.version },
        data: { state: "accepted", solver, deadline: newDeadline, version: row.version + 1 },
      });
      if (updated.count === 0) return { intent: null, exposureExceeded: false };
      return {
        intent: rowToIntent({ ...row, state: "accepted", solver, deadline: newDeadline, version: row.version + 1 }),
        exposureExceeded: false,
      };
    });
  }

  async fillIfAccepted(
    id: string,
    solver: string,
    patch: Pick<Partial<Intent>, "filledAt" | "fillAmount" | "feeAmount" | "txHash">,
    now?: number,
    expectedVersion?: number,
  ): Promise<MutationResult> {
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    return this.prisma.withDefaultTimeout(async (tx) => {
      const existing = await (tx as unknown as typeof this.prisma).intent.findUnique({
        where: { intentId: id },
      });
      if (!existing) return null;
      const row = existing as IntentRow;
      if (row.state !== "accepted" || row.solver !== solver || row.deadline <= nowSec) return null;
      if (expectedVersion !== undefined && row.version !== expectedVersion) {
        return new VersionConflict(id, expectedVersion, row.version);
      }
      const updated = await (tx as unknown as typeof this.prisma).intent.updateMany({
        where: { intentId: id, state: "accepted", solver, version: row.version, deadline: { gt: nowSec } },
        data: { ...patch, state: "filled", version: row.version + 1 },
      });
      if (updated.count === 0) return null;
      return rowToIntent({ ...row, ...patch, state: "filled", version: row.version + 1 });
    });
  }

  async cancelIfOpen(id: string, expectedVersion?: number): Promise<MutationResult> {
    return this.conditionalTransition(id, "open", "cancelled", {}, expectedVersion);
  }

  async expireIfOpen(id: string, expectedVersion?: number): Promise<MutationResult> {
    return this.conditionalTransition(id, "open", "expired", {}, expectedVersion);
  }

  async extendDeadlineIfAccepted(
    id: string,
    newDeadline: number,
    expectedVersion?: number,
  ): Promise<MutationResult> {
    return this.prisma.withDefaultTimeout(async (tx) => {
      const existing = await (tx as unknown as typeof this.prisma).intent.findUnique({
        where: { intentId: id },
      });
      if (!existing) return null;
      const row = existing as IntentRow;
      if (row.state !== "accepted" || row.deadline >= newDeadline) return null;
      if (expectedVersion !== undefined && row.version !== expectedVersion) {
        return new VersionConflict(id, expectedVersion, row.version);
      }
      const updated = await (tx as unknown as typeof this.prisma).intent.updateMany({
        where: { intentId: id, state: "accepted", version: row.version, deadline: { lt: newDeadline } },
        data: { deadline: newDeadline, version: row.version + 1 },
      });
      if (updated.count === 0) return null;
      return rowToIntent({ ...row, deadline: newDeadline, version: row.version + 1 });
    });
  }

  async slashIfAccepted(
    id: string,
    patch: { slashedAt: number; slashReason: string },
    expectedVersion?: number,
  ): Promise<MutationResult> {
    return this.conditionalTransition(id, "accepted", "slashed", patch, expectedVersion);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Generic conditional-transition helper for simple state guards.
   */
  private async conditionalTransition(
    id: string,
    fromState: IntentState,
    toState: IntentState,
    extra: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<MutationResult> {
    return this.prisma.withDefaultTimeout(async (tx) => {
      const existing = await (tx as unknown as typeof this.prisma).intent.findUnique({
        where: { intentId: id },
      });
      if (!existing) return null;
      const row = existing as IntentRow;
      if (row.state !== fromState) return null;
      if (expectedVersion !== undefined && row.version !== expectedVersion) {
        return new VersionConflict(id, expectedVersion, row.version);
      }
      const updated = await (tx as unknown as typeof this.prisma).intent.updateMany({
        where: { intentId: id, state: fromState, version: row.version },
        data: { ...extra, state: toState, version: row.version + 1 },
      });
      if (updated.count === 0) return null;
      return rowToIntent({ ...row, ...extra, state: toState, version: row.version + 1 });
    });
  }

  /**
   * Resolve src/dst token FK columns from the tokens table (#410).
   * Returns the intent unchanged if either token is not in the registry.
   */
  private async resolveTokenFks(intent: Intent): Promise<Intent> {
    // Skip if already resolved.
    if (intent.srcTokenId && intent.dstTokenId) return intent;

    try {
      const [srcToken, dstToken] = await Promise.all([
        !intent.srcTokenId
          ? this.prisma.token.findUnique({
              where: {
                address_chain: {
                  address: intent.srcToken.address,
                  chain: intent.srcChain as string,
                },
              },
              select: { id: true, decimals: true },
            })
          : null,
        !intent.dstTokenId
          ? this.prisma.token.findUnique({
              where: {
                address_chain: {
                  address: intent.dstToken.contract,
                  chain: "stellar" as string,
                },
              },
              select: { id: true, decimals: true },
            })
          : null,
      ]);

      return {
        ...intent,
        srcTokenId: intent.srcTokenId ?? srcToken?.id ?? undefined,
        dstTokenId: intent.dstTokenId ?? dstToken?.id ?? undefined,
        srcDecimals: intent.srcDecimals ?? srcToken?.decimals ?? undefined,
        dstDecimals: intent.dstDecimals ?? dstToken?.decimals ?? undefined,
      };
    } catch (err) {
      this.logger.warn(`[#410] Failed to resolve token FKs for intent ${intent.intentId}: ${(err as Error).message}`);
      return intent;
    }
  }

  /**
   * Convert a solver address string to a 64-bit integer for use as a Postgres
   * advisory lock key (per-solver serialization of exposure-cap check).
   *
   * We use a simple hash so the lock key stays within int8 range.
   */
  private solverAdvisoryLockKey(solver: string): bigint {
    let hash = 0n;
    for (let i = 0; i < solver.length; i++) {
      hash = (hash * 31n + BigInt(solver.charCodeAt(i))) & 0x7FFFFFFFFFFFFFFFn;
    }
    return hash;
  }
}

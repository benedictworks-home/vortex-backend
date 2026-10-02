import { Injectable } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { Intent, IntentState } from "./intents.types";
import { buildSeedIntents } from "./intents.seed";

/**
 * NestJS injection token for the intents repository.
 *
 * @example
 *   \@Inject(INTENTS_REPOSITORY) private readonly repo: IIntentsRepository
 */
export const INTENTS_REPOSITORY = Symbol("INTENTS_REPOSITORY");

// ─── Optimistic-concurrency types (#404) ─────────────────────────────────────

/**
 * Returned by mutations when the caller's `expectedVersion` does not match
 * the row's actual version.  The caller should re-read the row, reconcile,
 * and retry.
 */
export class VersionConflict {
  constructor(
    readonly intentId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {}
}

export function isVersionConflict(result: unknown): result is VersionConflict {
  return result instanceof VersionConflict;
}

/**
 * Union of successful intent result and version conflict.
 * All guarded mutation methods return this type.
 */
export type MutationResult = Intent | VersionConflict | null;

// ─── Idempotency (#404) ───────────────────────────────────────────────────────

export interface IdempotentCreateResult {
  intent: Intent;
  /** true when a new row was created; false when the key already existed (replay). */
  created: boolean;
}

// ─── Patch type ───────────────────────────────────────────────────────────────

export type IntentPatch = Partial<Omit<Intent, "intentId" | "createdAt">>;

// ─── Repository interface ─────────────────────────────────────────────────────

export interface IIntentsRepository {
  save(intent: Intent): Intent | Promise<Intent>;
  findById(id: string): Intent | undefined | Promise<Intent | undefined>;
  findAll(): Intent[] | Promise<Intent[]>;
  findByState(state: IntentState): Intent[] | Promise<Intent[]>;
  findByUser(user: string): Intent[] | Promise<Intent[]>;
  findManyByIds(ids: string[]): Intent[] | Promise<Intent[]>;
  countAcceptedBySolver(solver: string): number | Promise<number>;
  countActiveByUser(user: string): number | Promise<number>;

  /**
   * Idempotent create: inserts only when no row exists for `idempotencyKey`
   * with `createdAt >= minCreatedAt`.  Returns the existing row on replay.
   */
  createIdempotent(
    intent: Intent,
    idempotencyKey: string,
    minCreatedAt: number,
  ): IdempotentCreateResult | Promise<IdempotentCreateResult>;

  findByIdempotencyKey(
    key: string,
    minCreatedAt: number,
  ): Intent | undefined | Promise<Intent | undefined>;

  /**
   * Apply a partial patch.  Returns VersionConflict on stale write, null when
   * the intent is not found.
   * Atomically replace an open intent's minimum output and deadline while its
   * current deadline is still in the future. Returns null when the intent is
   * missing, no longer open, or already expired.
   */
  amendIfOpen(
    id: string,
    patch: Pick<Intent, "minDstAmount" | "deadline">,
    now?: number,
  ): Intent | null | Promise<Intent | null>;

  /**
   * Remove a stored intent. Used only for in-memory retention sweeps for stale
   * terminal-state records; Prisma-backed stores ignore this call by design.
   */
  update(
    id: string,
    patch: IntentPatch,
    expectedVersion: number,
  ): MutationResult | Promise<MutationResult>;

  delete(id: string): boolean | Promise<boolean>;

  // ── Atomic state transitions ──────────────────────────────────────────────

  acceptIfOpen(
    id: string,
    solver: string,
    newDeadline: number,
    now?: number,
    expectedVersion?: number,
  ): MutationResult | Promise<MutationResult>;

  acceptIfOpenWithinExposure(
    id: string,
    solver: string,
    newDeadline: number,
    now: number,
    candidateExposureUsdMicros: bigint,
    maxExposureUsdMicros: bigint,
  ): Promise<{ intent: Intent | null; exposureExceeded: boolean }> | { intent: Intent | null; exposureExceeded: boolean };

  /**
   * Atomically transition an intent from `accepted` → `filled` only if it is
   * currently accepted by the specified solver AND the fill window has not
   * elapsed. Mirrors the DB pattern:
   *   UPDATE intents SET state='filled', ...patch
   *   WHERE intent_id=$1 AND state='accepted' AND solver=$2 AND deadline > $3
   *   RETURNING *
   * Returns the updated intent on success, `null` on any guard failure.
   * The `minDstAmount` invariant (fill >= minDst) is enforced by the
   * controller/service layer with bigint comparison before this write; the
   * state+deadline predicates here make the write itself race-free.
   */
  fillIfAccepted(
    id: string,
    solver: string,
    patch: Pick<Partial<Intent>, "filledAt" | "fillAmount" | "feeAmount" | "txHash">,
    now?: number,
    expectedVersion?: number,
  ): MutationResult | Promise<MutationResult>;

  cancelIfOpen(id: string, expectedVersion?: number): MutationResult | Promise<MutationResult>;

  expireIfOpen(id: string, expectedVersion?: number): MutationResult | Promise<MutationResult>;

  extendDeadlineIfAccepted(
    id: string,
    newDeadline: number,
    expectedVersion?: number,
  ): MutationResult | Promise<MutationResult>;

  slashIfAccepted(
    id: string,
    patch: { slashedAt: number; slashReason: string },
    expectedVersion?: number,
  ): MutationResult | Promise<MutationResult>;

  /**
   * Version-guarded upsert used by the dual-write mirror.
   * Only saves when the incoming version is >= the stored version.
   */
  saveIfNewer?(intent: Intent): Promise<Intent>;
}

// ─── In-memory implementation ─────────────────────────────────────────────────

@Injectable()
export class InMemoryIntentsRepository implements IIntentsRepository {
  private readonly store = new Map<string, Intent>();
  /** key → intentId (idempotency replay cache) */
  private readonly idempotencyKeys = new Map<string, string>();

  constructor(options?: { seed?: boolean }) {
    const shouldSeed = options?.seed !== false;
    if (shouldSeed) this.seed();
  }

  save(intent: Intent): Intent {
    this.store.set(intent.intentId, intent);
    return intent;
  }

  findById(id: string): Intent | undefined {
    return this.store.get(id);
  }

  findAll(): Intent[] {
    return [...this.store.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  findByState(state: IntentState): Intent[] {
    return this.findAll().filter((i) => i.state === state);
  }

  findByUser(user: string): Intent[] {
    const lower = user.toLowerCase();
    return this.findAll().filter((i) => i.user.toLowerCase() === lower);
  }

  findManyByIds(ids: string[]): Intent[] {
    const unique = [...new Set(ids)];
    return unique.flatMap((id) => {
      const i = this.store.get(id);
      return i ? [i] : [];
    });
  }

  countAcceptedBySolver(solver: string): number {
    const lower = solver.toLowerCase();
    return [...this.store.values()].filter(
      (i) => i.state === "accepted" && i.solver?.toLowerCase() === lower,
    ).length;
  }

  countActiveByUser(user: string): number {
    const lower = user.toLowerCase();
    return [...this.store.values()].filter(
      (i) => (i.state === "open" || i.state === "accepted") && i.user.toLowerCase() === lower,
    ).length;
  }

  createIdempotent(
    intent: Intent,
    idempotencyKey: string,
    minCreatedAt: number,
  ): IdempotentCreateResult {
    const existing = this.findByIdempotencyKey(idempotencyKey, minCreatedAt);
    if (existing) return { intent: existing, created: false };
    this.save(intent);
    this.idempotencyKeys.set(idempotencyKey, intent.intentId);
    return { intent, created: true };
  }

  findByIdempotencyKey(key: string, minCreatedAt: number): Intent | undefined {
    const id = this.idempotencyKeys.get(key);
    if (!id) return undefined;
    const intent = this.store.get(id);
    if (!intent || intent.createdAt < minCreatedAt) return undefined;
    return intent;
  }

  update(id: string, patch: IntentPatch, expectedVersion: number): MutationResult {
    const existing = this.store.get(id);
    if (!existing) return null;
    if (existing.version !== expectedVersion) {
      return new VersionConflict(id, expectedVersion, existing.version);
    }
    const updated: Intent = { ...existing, ...patch, version: existing.version + 1 };
    this.store.set(id, updated);
    return updated;
  }

  amendIfOpen(
    id: string,
    patch: Pick<Intent, "minDstAmount" | "deadline">,
    now = Math.floor(Date.now() / 1000),
  ): Intent | null {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "open" || existing.deadline <= now || patch.deadline <= now) {
      return null;
    }
    const updated: Intent = { ...existing, ...patch };
    this.store.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }

  saveIfNewer(intent: Intent): Promise<Intent> {
    const existing = this.store.get(intent.intentId);
    if (!existing || intent.version >= existing.version) {
      this.store.set(intent.intentId, intent);
    }
    return Promise.resolve(this.store.get(intent.intentId)!);
  }

  // ── Atomic transitions ────────────────────────────────────────────────────

  acceptIfOpen(
    id: string,
    solver: string,
    newDeadline: number,
    now?: number,
    expectedVersion?: number,
  ): MutationResult {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "open") return null;
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    if (existing.deadline <= nowSec) return null;
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      return new VersionConflict(id, expectedVersion, existing.version);
    }
    const updated: Intent = {
      ...existing,
      state: "accepted",
      solver,
      deadline: newDeadline,
      version: existing.version + 1,
    };
    this.store.set(id, updated);
    return updated;
  }

  acceptIfOpenWithinExposure(
    id: string,
    solver: string,
    newDeadline: number,
    now: number,
    candidateExposureUsdMicros: bigint,
    maxExposureUsdMicros: bigint,
  ): { intent: Intent | null; exposureExceeded: boolean } {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "open" || existing.deadline <= now) {
      return { intent: null, exposureExceeded: false };
    }
    const lower = solver.toLowerCase();
    let acceptedExposure = 0n;
    for (const intent of this.store.values()) {
      if (intent.state === "accepted" && intent.solver?.toLowerCase() === lower) {
        acceptedExposure += intentExposureUsdMicros(intent, now);
      }
    }
    if (acceptedExposure + candidateExposureUsdMicros > maxExposureUsdMicros) {
      return { intent: null, exposureExceeded: true };
    }
    const updated: Intent = {
      ...existing,
      state: "accepted",
      solver,
      deadline: newDeadline,
      version: existing.version + 1,
    };
    this.store.set(id, updated);
    return { intent: updated, exposureExceeded: false };
  }

  fillIfAccepted(
    id: string,
    solver: string,
    patch: Pick<Partial<Intent>, "filledAt" | "fillAmount" | "feeAmount" | "txHash">,
    now?: number,
    expectedVersion?: number,
  ): MutationResult {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "accepted" || existing.solver !== solver) return null;
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    if (existing.deadline <= nowSec) return null;
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      return new VersionConflict(id, expectedVersion, existing.version);
    }
    const updated: Intent = { ...existing, ...patch, state: "filled", version: existing.version + 1 };
    this.store.set(id, updated);
    return updated;
  }

  cancelIfOpen(id: string, expectedVersion?: number): MutationResult {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "open") return null;
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      return new VersionConflict(id, expectedVersion, existing.version);
    }
    const updated: Intent = { ...existing, state: "cancelled", version: existing.version + 1 };
    this.store.set(id, updated);
    return updated;
  }

  expireIfOpen(id: string, expectedVersion?: number): MutationResult {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "open") return null;
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      return new VersionConflict(id, expectedVersion, existing.version);
    }
    const updated: Intent = { ...existing, state: "expired", version: existing.version + 1 };
    this.store.set(id, updated);
    return updated;
  }

  extendDeadlineIfAccepted(id: string, newDeadline: number, expectedVersion?: number): MutationResult {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "accepted") return null;
    if (existing.deadline >= newDeadline) return null;
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      return new VersionConflict(id, expectedVersion, existing.version);
    }
    const updated: Intent = { ...existing, deadline: newDeadline, version: existing.version + 1 };
    this.store.set(id, updated);
    return updated;
  }

  slashIfAccepted(
    id: string,
    patch: { slashedAt: number; slashReason: string },
    expectedVersion?: number,
  ): MutationResult {
    const existing = this.store.get(id);
    if (!existing || existing.state !== "accepted") return null;
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      return new VersionConflict(id, expectedVersion, existing.version);
    }
    const updated: Intent = { ...existing, ...patch, state: "slashed", version: existing.version + 1 };
    this.store.set(id, updated);
    return updated;
  }

  // ── Seed ────────────────────────────────────────────────────────────────────

  seed(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const data of buildSeedIntents(now)) {
      const intent: Intent = {
        ...data,
        intentId: uuidv4(),
        createdAt: now - Math.floor(Math.random() * 600),
        version: 0,
        srcVerified: true,
      };
      this.store.set(intent.intentId, intent);
    }
  }
}

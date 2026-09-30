import Redis from "ioredis";

/** Injection token for the {@link LivenessStore} provider. */
export const SOLVERS_LIVENESS_STORE = "SOLVERS_LIVENESS_STORE";

/**
 * Shared liveness state for solver heartbeats (issue #445).
 *
 * Two pieces of state per solver:
 *
 * - **liveness key** — refreshed on every heartbeat with the offline window
 *   as TTL. Any replica that can see the key knows the solver is beating;
 *   expiry (or absence) after the window means "3 missed heartbeats".
 * - **auto-offline flag** — set when the liveness system takes a solver
 *   offline, cleared when it brings it back. This distinguishes
 *   "offline because it stopped heartbeating" (re-activatable by the next
 *   heartbeat) from "offline because it deactivated itself" (which must
 *   never be flipped back by a heartbeat).
 *
 * Every method resolves rather than rejects: `liveness()` reports
 * `"unknown"` when the backing store cannot be consulted, which callers use
 * to abort a sweep cycle instead of flapping solvers offline during a
 * partition.
 */
export interface LivenessStore {
  /** Refreshes the solver's liveness key so it expires after `ttlMs`. */
  touch(address: string, ttlMs: number): Promise<void>;

  /**
   * Reports the solver's shared liveness key: `"live"` while present,
   * `"missing"` once absent/expired, `"unknown"` when the store could not
   * be reached (error or partition).
   */
  liveness(address: string): Promise<"live" | "missing" | "unknown">;

  /** True when this solver was taken offline by the liveness system itself. */
  isAutoOffline(address: string): Promise<boolean>;

  /** Flags the solver as offline-by-liveness so heartbeats may re-activate it. */
  markAutoOffline(address: string): Promise<void>;

  /** Clears the auto-offline flag after a successful re-activation. */
  clearAutoOffline(address: string): Promise<void>;
}

/**
 * Process-local store for dev/test and single-replica deployments without
 * Redis (issue #445). Expiry is evaluated lazily against `Date.now()`, so
 * jest fake timers drive it deterministically.
 */
export class MemoryLivenessStore implements LivenessStore {
  private readonly expiries = new Map<string, number>();
  private readonly autoOffline = new Set<string>();

  async touch(address: string, ttlMs: number): Promise<void> {
    this.expiries.set(address, Date.now() + ttlMs);
  }

  async liveness(address: string): Promise<"live" | "missing" | "unknown"> {
    const expiresAt = this.expiries.get(address);
    if (expiresAt === undefined) return "missing";
    if (expiresAt <= Date.now()) {
      this.expiries.delete(address);
      return "missing";
    }
    return "live";
  }

  async isAutoOffline(address: string): Promise<boolean> {
    return this.autoOffline.has(address);
  }

  async markAutoOffline(address: string): Promise<void> {
    this.autoOffline.add(address);
  }

  async clearAutoOffline(address: string): Promise<void> {
    this.autoOffline.delete(address);
  }
}

/**
 * Redis-backed store shared by every replica (issue #445).
 *
 * Liveness keys carry the offline window as TTL, so Redis itself is the
 * cross-replica source of truth — no keyspace-notification configuration is
 * required: replicas discover expiry by polling `EXISTS` once per sweep
 * (see {@link SolverLivenessService}), which works on any Redis setup and
 * degrades to "skip the cycle" instead of "mark everyone offline" when the
 * store is unreachable.
 */
export class RedisLivenessStore implements LivenessStore {
  constructor(private readonly redis: Redis) {}

  async touch(address: string, ttlMs: number): Promise<void> {
    // setex takes seconds; the offline window is always >= 1s in practice.
    const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.redis.setex(this.livenessKey(address), ttlSeconds, String(Date.now()));
  }

  async liveness(address: string): Promise<"live" | "missing" | "unknown"> {
    try {
      const exists = await this.redis.exists(this.livenessKey(address));
      return exists === 1 ? "live" : "missing";
    } catch {
      return "unknown";
    }
  }

  async isAutoOffline(address: string): Promise<boolean> {
    try {
      return (await this.redis.exists(this.autoKey(address))) === 1;
    } catch {
      // Fail closed on re-activation: during an outage we simply do not
      // flip records back to live; the next heartbeat retries.
      return false;
    }
  }

  async markAutoOffline(address: string): Promise<void> {
    try {
      await this.redis.set(this.autoKey(address), "1");
    } catch {
      // Best effort — an unflagged record is re-detected by the next sweep.
    }
  }

  async clearAutoOffline(address: string): Promise<void> {
    try {
      await this.redis.del(this.autoKey(address));
    } catch {
      // Best effort — see markAutoOffline.
    }
  }

  private livenessKey(address: string): string {
    return `solver:liveness:${address}`;
  }

  private autoKey(address: string): string {
    return `solver:auto-offline:${address}`;
  }
}

/**
 * Builds the store for the configured URL (issue #445): `""` (no
 * `SOLVER_HEARTBEAT_REDIS_URL`/`REDIS_URL`) selects the process-local
 * memory store; any redis/rediss URL selects the shared Redis store with
 * fail-fast, non-queueing commands so a partition surfaces as `"unknown"`
 * instead of hanging the sweep.
 */
export function createLivenessStore(redisUrl: string): LivenessStore {
  if (!redisUrl) return new MemoryLivenessStore();
  return new RedisLivenessStore(
    new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    }),
  );
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { AppConfig } from "../config/configuration";

/**
 * Replica health state updated by the lag-check background probe.
 */
interface ReplicaState {
  client: PrismaClient;
  url: string;
  lagMs: number | null;    // null = unknown / never checked
  healthy: boolean;
  lastCheckedAt: number;
}

/**
 * PrismaReplicaService (#411).
 *
 * Manages a pool of Prisma clients — one for the primary write path and zero
 * or more for read replicas defined in DATABASE_REPLICA_URLS.
 *
 * Replica lag is measured via pg_last_xact_replay_timestamp() on each
 * replica.  Replicas whose lag exceeds MAX_REPLICA_LAG_MS are bypassed so
 * the primary receives the fallback read.  All replicas lagging simultaneously
 * causes primary fallback and emits a warning log so operators are notified.
 *
 * Read-your-writes: callers with a recent-write token should call
 * `primary()` directly so their follow-up reads see the committed write.
 *
 * Usage inside a repository:
 *   const client = this.replica.pickClient(); // healthy replica or primary
 *   const rows = await client.intent.findMany({ ... });
 */
@Injectable()
export class PrismaReplicaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaReplicaService.name);
  private readonly replicas: ReplicaState[] = [];
  private lagCheckTimer: ReturnType<typeof setInterval> | undefined;

  /** Round-robin counter for replica selection. */
  private rrIndex = 0;

  constructor(
    private readonly primaryClient: PrismaClient,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async onModuleInit(): Promise<void> {
    const replicaUrls = this.config
      .get("databaseReplicaUrls", { infer: true })
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);

    for (const url of replicaUrls) {
      const client = new PrismaClient({ datasources: { db: { url } } });
      await client.$connect();
      this.replicas.push({ client, url, lagMs: null, healthy: true, lastCheckedAt: 0 });
      this.logger.log(`[replica] Connected to read replica: ${this.sanitizeUrl(url)}`);
    }

    if (this.replicas.length > 0) {
      // Initial lag check before serving any reads.
      await this.checkAllLags();
      // Schedule periodic lag checks every 2 s.
      this.lagCheckTimer = setInterval(() => void this.checkAllLags(), 2000);
    } else {
      this.logger.log("[replica] No DATABASE_REPLICA_URLS configured — all reads go to primary");
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.lagCheckTimer) clearInterval(this.lagCheckTimer);
    await Promise.allSettled(this.replicas.map((r) => r.client.$disconnect()));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Returns the primary PrismaClient (always for writes). */
  primary(): PrismaClient {
    return this.primaryClient;
  }

  /**
   * Returns a healthy replica PrismaClient for read operations.
   * Falls back to the primary when:
   *  - No replicas are configured.
   *  - All replicas exceed MAX_REPLICA_LAG_MS.
   *  - All replicas are unhealthy.
   */
  pickClient(): PrismaClient {
    const maxLagMs = this.config.get("maxReplicaLagMs", { infer: true });
    const healthy = this.replicas.filter(
      (r) => r.healthy && (r.lagMs === null || r.lagMs <= maxLagMs),
    );

    if (healthy.length === 0) {
      if (this.replicas.length > 0) {
        this.logger.warn("[replica] All replicas lagging or unhealthy — falling back to primary");
      }
      return this.primaryClient;
    }

    // Round-robin selection across healthy replicas.
    const selected = healthy[this.rrIndex % healthy.length];
    this.rrIndex = (this.rrIndex + 1) % healthy.length;
    return selected.client;
  }

  /** Returns a snapshot of current replica health for observability. */
  replicaStats(): Array<{ url: string; lagMs: number | null; healthy: boolean }> {
    return this.replicas.map((r) => ({
      url: this.sanitizeUrl(r.url),
      lagMs: r.lagMs,
      healthy: r.healthy,
    }));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async checkAllLags(): Promise<void> {
    await Promise.allSettled(this.replicas.map((r) => this.checkLag(r)));
  }

  private async checkLag(state: ReplicaState): Promise<void> {
    try {
      /**
       * pg_last_xact_replay_timestamp() returns the timestamp of the last
       * transaction replayed from the WAL.  The difference between NOW() and
       * that timestamp is the streaming replication lag.
       *
       * Returns NULL on a standby that has never replayed a transaction (brand-
       * new replica) or on the primary itself — in both cases we treat lag as 0.
       */
      const result = await state.client.$queryRaw<Array<{ lag_ms: number | null }>>`
        SELECT
          CASE
            WHEN pg_is_in_recovery()
            THEN EXTRACT(MILLISECONDS FROM (NOW() - pg_last_xact_replay_timestamp()))
            ELSE 0
          END AS lag_ms
      `;
      state.lagMs = result[0]?.lag_ms ?? 0;
      state.healthy = true;
      state.lastCheckedAt = Date.now();
    } catch (err) {
      this.logger.warn(
        `[replica] Lag check failed for ${this.sanitizeUrl(state.url)}: ${(err as Error).message}`,
      );
      state.lagMs = null;
      state.healthy = false;
    }
  }

  private sanitizeUrl(url: string): string {
    // Strip credentials from the URL for safe logging.
    try {
      const u = new URL(url);
      u.password = "***";
      u.username = "***";
      return u.toString();
    } catch {
      return "<invalid-url>";
    }
  }
}

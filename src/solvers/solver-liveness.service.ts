import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../config/configuration";
import { IntentFeedService } from "../intents/feed/intent-feed.service";
import { SUPPORTED_CHAINS } from "../intents/intents.types";
import { MetricsService } from "../metrics/metrics.service";
import { LivenessStore, SOLVERS_LIVENESS_STORE } from "./liveness.store";
import { SolversService } from "./solvers.service";
import type { SolverRecord } from "./solvers.types";

/** Default heartbeat cadence pushed to clients (issue #445). */
export const SOLVER_HEARTBEAT_DEFAULT_INTERVAL_MS = 10_000;
/** Default number of missed heartbeats before a solver is marked offline. */
export const SOLVER_HEARTBEAT_DEFAULT_MISSES = 3;

/** Response of a successful heartbeat (`WS heartbeat_ack` / REST ack). */
export interface SolverHeartbeatAck {
  status: "online" | "offline";
  /** `lastActiveAt` as persisted (refreshed on status transitions). */
  lastActiveAt?: number;
  /** Cadence the client should honour — the negotiated interval (issue #445). */
  heartbeatIntervalMs: number;
}

/**
 * Drives solver liveness from heartbeats (issue #445).
 *
 * Every heartbeat (`touch`) refreshes two views: this replica's in-memory
 * expiry and the shared store's TTL key (Redis in multi-replica setups). A
 * periodic `sweep` compares both — a solver is transitioned to offline only
 * when **neither** this replica saw a heartbeat within the offline window
 * **nor** the shared key still exists, and only once the boot grace has
 * elapsed. Offline transitions flip `isActive=false` (so quote/RFQ and
 * capability filtering drop the solver), persist `lastActiveAt`, flag the
 * record as auto-offline, and broadcast a `solver_status_changed` event on
 * the WS/SSE feed. The next heartbeat on an auto-offline record brings it
 * back online the same way.
 *
 * Partition safety: when the shared store cannot be consulted the sweep
 * aborts before applying any transition, and this replica's own fresh
 * heartbeats are always honoured — so one partitioned replica can never
 * flap solvers offline en masse. Deliberate deactivations
 * (`isActive=false` without the auto-offline flag) are never overridden by
 * heartbeats.
 */
@Injectable()
export class SolverLivenessService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SolverLivenessService.name);
  /** This replica's newest heartbeat expiry per solver address. */
  private readonly localExpiry = new Map<string, number>();
  /** Per-solver liveness view used by capability predicates (unknown → live). */
  private readonly live = new Map<string, boolean>();
  /** Addresses currently being re-activated, to serialise concurrent heals. */
  private readonly healing = new Set<string>();
  private timer?: NodeJS.Timeout;
  private sweeping = false;
  private readonly startedAt = Date.now();

  constructor(
    private readonly solvers: SolversService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(SOLVERS_LIVENESS_STORE) private readonly store: LivenessStore,
    private readonly feed: IntentFeedService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /** Negotiated client heartbeat cadence in milliseconds (default 10 000). */
  get heartbeatIntervalMs(): number {
    return this.config.get("solverHeartbeatIntervalMs", { infer: true }) ?? SOLVER_HEARTBEAT_DEFAULT_INTERVAL_MS;
  }

  /** Missed heartbeats tolerated before offline (default 3). */
  get heartbeatMisses(): number {
    return this.config.get("solverHeartbeatMisses", { infer: true }) ?? SOLVER_HEARTBEAT_DEFAULT_MISSES;
  }

  /** Offline window: `heartbeatIntervalMs × heartbeatMisses` (default 30 000). */
  get offlineWindowMs(): number {
    return this.heartbeatIntervalMs * this.heartbeatMisses;
  }

  /**
   * Records a heartbeat from `address`.
   *
   * Refreshes the local + shared liveness views. When the record was taken
   * offline by this system (`auto-offline` flag) the heartbeat re-activates
   * it and emits `solver_status_changed: online`; a deliberately deactivated
   * record stays offline. The ack carries the negotiated interval so the
   * client knows its cadence.
   *
   * @returns the ack, or `null` when no solver has that address.
   * @throws Propagates repository errors — WS callers should catch.
   */
  async touch(address: string): Promise<SolverHeartbeatAck | null> {
    const record = await this.solvers.get(address);
    if (!record) return null;

    this.localExpiry.set(address, Date.now() + this.offlineWindowMs);
    this.live.set(address, true);
    try {
      await this.store.touch(address, this.offlineWindowMs);
    } catch (error) {
      this.logger.debug(`liveness store touch failed for ${address}: ${errorMessage(error)}`);
    }

    if (!record.isActive) {
      if (await this.store.isAutoOffline(address)) {
        const healed = await this.heal(address, record);
        const lastActiveAt = healed?.lastActiveAt ?? record.lastActiveAt;
        return { status: "online", lastActiveAt, heartbeatIntervalMs: this.heartbeatIntervalMs };
      }
      return { status: "offline", lastActiveAt: record.lastActiveAt, heartbeatIntervalMs: this.heartbeatIntervalMs };
    }
    return { status: "online", lastActiveAt: record.lastActiveAt, heartbeatIntervalMs: this.heartbeatIntervalMs };
  }

  /**
   * Synchronous liveness view for hot paths (capability predicates).
   *
   * Addresses never seen by this replica default to *live* — the first
   * sweep replaces every unknown with the shared-store verdict, so the
   * optimistic default only covers the window right after boot.
   */
  isLive(address: string): boolean {
    return this.live.get(address) ?? true;
  }

  /**
   * Drops the auto-offline flag for `address` (issue #445). Called when an
   * admin action (`deactivate`/`deregister`) takes the solver offline: a
   * later heartbeat must never re-activate a deliberate deactivation.
   */
  async clearAutoOffline(address: string): Promise<void> {
    await this.store.clearAutoOffline(address);
  }

  /**
   * One detection cycle: refresh the liveness view for every active solver
   * from the shared store, then transition offline the ones that missed the
   * window (after the boot grace). Aborts with no transitions when the
   * store reports `"unknown"` — a partitioned replica must not flap its
   * solvers. Called on a timer ({@link onModuleInit}) and directly in tests.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Date.now();
      const inGrace = now - this.startedAt < this.offlineWindowMs;
      const active = (await this.solvers.getAll()).filter((solver) => solver.isActive);

      // Phase 1 — read shared verdicts; abort the whole cycle on store failure.
      const verdicts: Array<{ solver: SolverRecord; live: boolean }> = [];
      for (const solver of active) {
        const shared = await this.store.liveness(solver.address);
        if (shared === "unknown") {
          this.logger.warn(
            "liveness sweep aborted: shared store unreachable (partition guard, no transitions applied)",
          );
          return;
        }
        const localLive = (this.localExpiry.get(solver.address) ?? 0) > now;
        verdicts.push({ solver, live: localLive || shared === "live" });
      }

      // Phase 2 — apply. Beyond the boot grace, a fresh `lastActiveAt`
      // (registration, reactivation, or a fill within one offline window)
      // is proof of life: the solver gets its full window to connect and
      // beat before being excluded from RFQ/routing.
      for (const verdict of verdicts) {
        this.live.set(verdict.solver.address, verdict.live);
        if (verdict.live || inGrace) continue;
        const proofOfLife = now - verdict.solver.lastActiveAt * 1000 < this.offlineWindowMs;
        if (!proofOfLife) {
          await this.transitionOffline(verdict.solver);
        }
      }
      await this.refreshMetrics();
    } finally {
      this.sweeping = false;
    }
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep().catch((error) =>
        this.logger.warn(`liveness sweep failed: ${errorMessage(error)}`),
      );
    }, this.heartbeatIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── Transitions ───────────────────────────────────────────────────────────

  /** Marks a timed-out solver offline: record, flag, view, event, metrics. */
  private async transitionOffline(solver: SolverRecord): Promise<void> {
    // Re-check both liveness views: a beat may have landed between the
    // verdict read (phase 1) and this apply — on this replica or another.
    // An unreachable store at re-check also fails safe (skip, don't flip).
    if ((this.localExpiry.get(solver.address) ?? 0) > Date.now()) return;
    const shared = await this.store.liveness(solver.address);
    if (shared !== "missing") return;
    // Re-read the record: another replica may have transitioned it while we swept.
    const fresh = await this.solvers.get(solver.address);
    if (!fresh?.isActive) return;

    const updated = (await this.solvers.markOffline(solver.address)) ?? fresh;
    await this.store.markAutoOffline(solver.address);
    this.localExpiry.delete(solver.address);
    this.live.set(solver.address, false);
    await this.emitStatus(solver.address, "offline", updated.lastActiveAt, "missed_heartbeats");
    this.logger.log(
      `solver liveness: ${solver.address} offline after ${this.heartbeatMisses} missed heartbeats`,
    );
  }

  /** Re-activates an auto-offline solver whose heartbeat came back. */
  private async transitionOnline(record: SolverRecord): Promise<SolverRecord | undefined> {
    const updated = await this.solvers.markLive(record.address);
    await this.store.clearAutoOffline(record.address);
    this.localExpiry.set(record.address, Date.now() + this.offlineWindowMs);
    this.live.set(record.address, true);
    await this.emitStatus(record.address, "online", updated?.lastActiveAt, "heartbeat");
    await this.refreshMetrics();
    this.logger.log(`solver liveness: ${record.address} back online`);
    return updated;
  }

  /** Serialises re-activation so concurrent heartbeats emit one transition. */
  private async heal(address: string, record: SolverRecord): Promise<SolverRecord | undefined> {
    if (this.healing.has(address)) return undefined;
    this.healing.add(address);
    try {
      return await this.transitionOnline(record);
    } finally {
      this.healing.delete(address);
    }
  }

  private async emitStatus(
    address: string,
    status: "online" | "offline",
    lastActiveAt: number | undefined,
    reason: string,
  ): Promise<void> {
    try {
      await this.feed.broadcast({
        type: "solver_status_changed",
        solver: address,
        status,
        lastActiveAt,
        reason,
        at: Math.floor(Date.now() / 1000),
      });
    } catch (error) {
      this.logger.warn(`solver_status_changed broadcast failed: ${errorMessage(error)}`);
    }
    this.metrics?.solverStatusChangesTotal.inc({ status });
  }

  /**
   * Publishes `vortex_solver_live_by_chain` — live (= active and not
   * auto-offline) solver count per supported chain, with `*` expanded to
   * every supported chain. Called at the end of each sweep and after
   * re-activations.
   */
  private async refreshMetrics(): Promise<void> {
    const gauge = this.metrics?.solverLiveByChain;
    if (!gauge) return;
    try {
      const counts = new Map<string, number>();
      for (const solver of await this.solvers.getAll()) {
        if (!solver.isActive || !this.isLive(solver.address)) continue;
        const chains = (solver.supportedChains as readonly string[]).includes("*")
          ? SUPPORTED_CHAINS
          : solver.supportedChains;
        for (const chain of chains) counts.set(chain, (counts.get(chain) ?? 0) + 1);
      }
      gauge.reset();
      for (const chain of SUPPORTED_CHAINS) gauge.set({ chain }, counts.get(chain) ?? 0);
    } catch (error) {
      this.logger.warn(`live-solver metric refresh failed: ${errorMessage(error)}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

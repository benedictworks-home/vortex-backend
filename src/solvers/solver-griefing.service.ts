import { Injectable, Logger } from "@nestjs/common";
import {
  GriefingAuditEntry,
  GriefingConfig,
  GriefingState,
  SolverGriefingRecord,
  loadGriefingConfig,
} from "./solver-griefing.types";
import type { MetricsService } from "../metrics/metrics.service";

/**
 * Anti-griefing service for solvers (issue #453).
 *
 * Tracks a rolling unfilled-accept ratio per solver over a configurable time
 * window and applies escalating enforcement:
 *
 *   ok  →  cooldown  →  reduced-concurrency  →  suspended
 *
 * Enforcement is checked at accept time (via {@link checkAcceptAllowed}) and
 * updated when a fill window expires without a fill (via {@link recordUnfilled}).
 *
 * Design decisions
 * ────────────────
 * • Pure in-memory, no Prisma dependency — mirrors the pattern used by
 *   SolversService.pendingPenalties and the slash history.
 * • Thread-safe by construction: Node.js event loop is single-threaded, so
 *   all Map reads+writes within a single synchronous block are atomic.
 * • Configurable via env vars at startup (see loadGriefingConfig).  A live
 *   reload path is not wired up: threshold changes that need to take effect
 *   immediately require a restart — acceptable for a safety control.
 *
 * Testing: use `SolverGriefingService.withConfig(overrides)` to create a
 * test instance with tighter thresholds without injecting config via DI.
 */
@Injectable()
export class SolverGriefingService {
  private readonly logger = new Logger(SolverGriefingService.name);
  private readonly records = new Map<string, SolverGriefingRecord>();
  private readonly auditLog: GriefingAuditEntry[] = [];
  readonly config: GriefingConfig;

  /**
   * Optional MetricsService reference — set after construction via
   * {@link setMetrics}.  Kept optional so unit tests don't need the full
   * metrics stack, and so the service can be constructed before
   * MetricsModule is fully initialised (circular-ref safety).
   */
  private metrics: MetricsService | null = null;

  constructor() {
    this.config = loadGriefingConfig();
  }

  /**
   * Wire in the MetricsService after construction.
   * Called from SolversModule once both providers are ready.
   */
  setMetrics(metrics: MetricsService): void {
    this.metrics = metrics;
  }

  /**
   * Create a test instance with overridden config thresholds.
   * Use in unit tests instead of the NestJS DI path.
   */
  static withConfig(overrides: Partial<GriefingConfig>): SolverGriefingService {
    const instance = new SolverGriefingService();
    // Safe cast: we're patching a readonly field in a test helper.
    (instance as { config: GriefingConfig }).config = {
      ...loadGriefingConfig(),
      ...overrides,
    };
    return instance;
  }

  // ── Public enforcement API ────────────────────────────────────────────────

  /**
   * Called at intent accept time to determine whether the solver is allowed
   * to accept.
   *
   * Returns `{ allowed: true }` or `{ allowed: false, reason: string }`.
   *
   * Enforcement rules (evaluated in order):
   * 1. "suspended" → never allowed.
   * 2. "cooldown" and the cooldown has not yet expired → not allowed.
   * 3. "reduced-concurrency" and the solver already holds ≥ concurrencyLimit
   *    open accepts → not allowed.
   * 4. Otherwise → allowed.
   */
  checkAcceptAllowed(
    solverAddress: string,
    currentOpenAccepts: number,
    nowSeconds?: number,
  ): { allowed: boolean; reason?: string } {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    const record = this.getOrCreate(solverAddress, now);

    switch (record.state) {
      case "suspended":
        return { allowed: false, reason: "Solver is suspended due to repeated griefing" };

      case "cooldown": {
        if (record.cooldownUntil !== null && now < record.cooldownUntil) {
          const remaining = record.cooldownUntil - now;
          return {
            allowed: false,
            reason: `Solver is in cooldown for ${remaining}s due to high unfilled-accept ratio`,
          };
        }
        // Cooldown expired — transition back to ok automatically.
        this.transitionState(record, "ok", now, "cooldown_expired");
        break;
      }

      case "reduced-concurrency": {
        const limit = record.concurrencyLimit ?? this.config.reducedConcurrencyLimit;
        if (currentOpenAccepts >= limit) {
          return {
            allowed: false,
            reason: `Solver is limited to ${limit} concurrent accept(s) due to high unfilled-accept ratio`,
          };
        }
        break;
      }

      case "ok":
        break;
    }

    return { allowed: true };
  }

  /**
   * Record that a solver accepted an intent.
   * Must be called after the accept is committed to storage.
   */
  recordAccept(solverAddress: string, intentId: string, nowSeconds?: number): void {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    const record = this.getOrCreate(solverAddress, now);
    this.ensureActiveWindow(record, now);

    const window = record.windows[0];
    window.accepts++;

    this.appendAudit({
      timestamp: now,
      solverAddress,
      event: "accept_recorded",
      intentId,
      ratio: this.currentRatio(record),
    });

    this.logger.debug(
      `[griefing] accept recorded solver=${solverAddress} intent=${intentId} ratio=${this.currentRatio(record).toFixed(2)}`,
    );
  }

  /**
   * Record that a solver's accepted intent expired unfilled.
   *
   * This is the primary griefing signal. After recording, the ratio is
   * re-evaluated and the state machine may escalate.
   *
   * Intent IDs listed in `record.excludedIntentIds` are silently skipped so
   * operators can exclude incidents caused by network outages or protocol bugs.
   */
  recordUnfilled(solverAddress: string, intentId: string, nowSeconds?: number): void {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    const record = this.getOrCreate(solverAddress, now);

    // Incident exclusion — skip without counting.
    if (record.excludedIntentIds.has(intentId)) {
      this.logger.log(
        `[griefing] excluded incident skipped solver=${solverAddress} intent=${intentId}`,
      );
      return;
    }

    this.ensureActiveWindow(record, now);
    const window = record.windows[0];
    window.unfilled++;

    const ratio = this.currentRatio(record);

    this.appendAudit({
      timestamp: now,
      solverAddress,
      event: "unfilled_recorded",
      intentId,
      ratio,
    });

    this.logger.log(
      `[griefing] unfilled recorded solver=${solverAddress} intent=${intentId} ratio=${ratio.toFixed(2)} state=${record.state}`,
    );

    // Push ratio metric immediately so per-scrape staleness is bounded.
    if (this.metrics) {
      try {
        this.metrics.setGriefingRatio(solverAddress, ratio);
      } catch (err) {
        this.logger.error(`[griefing] ratio metric emit failed: ${(err as Error).message}`);
      }
    }

    this.evaluateAndEscalate(record, ratio, now);
  }

  /**
   * Exclude an intent from the ratio calculation (operator action).
   * Useful when a network outage or on-chain issue caused a legitimate solver
   * to miss a deadline through no fault of its own.
   */
  excludeIncident(
    solverAddress: string,
    intentId: string,
    operator?: string,
    nowSeconds?: number,
  ): void {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    const record = this.getOrCreate(solverAddress, now);
    record.excludedIntentIds.add(intentId);

    // Walk current windows and undo any unfilled count for this intent.
    // We track intentId per-window by re-scanning — cheap given window count.
    // The simplest correct approach: decrement one unfilled from the active
    // window if accepts > 0 and unfilled > 0.  A more precise approach would
    // tag each unfilled entry, but the benefit is small for an operator tool.
    for (const win of record.windows) {
      if (win.unfilled > 0) {
        win.unfilled--;
        break;
      }
    }

    this.appendAudit({
      timestamp: now,
      solverAddress,
      event: "incident_excluded",
      intentId,
      operator,
    });

    this.logger.log(
      `[griefing] incident excluded solver=${solverAddress} intent=${intentId} by=${operator ?? "system"}`,
    );

    // Re-evaluate: exclusion may unblock the solver.
    const ratio = this.currentRatio(record);
    this.evaluateAndEscalate(record, ratio, now);
  }

  /**
   * Manually reset a solver's griefing state to "ok" (operator action).
   * Clears cooldown and windows.
   */
  resetSolver(solverAddress: string, operator?: string, nowSeconds?: number): void {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    const record = this.getOrCreate(solverAddress, now);
    const fromState = record.state;

    record.state = "ok";
    record.cooldownUntil = null;
    record.concurrencyLimit = null;
    record.windows = [];
    record.escalationCount = 0;
    record.lastEscalatedAt = null;

    this.appendAudit({
      timestamp: now,
      solverAddress,
      event: "reset",
      fromState,
      toState: "ok",
      operator,
    });

    this.logger.log(
      `[griefing] solver reset solver=${solverAddress} from=${fromState} by=${operator ?? "system"}`,
    );
  }

  /**
   * Return the current anti-griefing record for a solver.
   * Returns null if no record exists (solver has never accepted anything).
   */
  getRecord(solverAddress: string): SolverGriefingRecord | null {
    return this.records.get(solverAddress) ?? null;
  }

  /**
   * Return the full anti-griefing audit log.
   * Optionally filtered to entries for a specific solver.
   */
  getAuditLog(solverAddress?: string): GriefingAuditEntry[] {
    if (!solverAddress) return [...this.auditLog];
    return this.auditLog.filter((e) => e.solverAddress === solverAddress);
  }

  /**
   * Compute the current unfilled-accept ratio across all active windows for
   * the given solver address.
   * Returns 0 if no record exists.
   */
  getCurrentRatio(solverAddress: string): number {
    const record = this.records.get(solverAddress);
    if (!record) return 0;
    return this.currentRatio(record);
  }

  /**
   * Return a summary of all solvers currently under enforcement.
   * Useful for the admin/metrics endpoints.
   */
  getEnforcedSolvers(): Array<{
    solverAddress: string;
    state: GriefingState;
    ratio: number;
    escalationCount: number;
  }> {
    const result = [];
    for (const record of this.records.values()) {
      if (record.state !== "ok") {
        result.push({
          solverAddress: record.solverAddress,
          state: record.state,
          ratio: this.currentRatio(record),
          escalationCount: record.escalationCount,
        });
      }
    }
    return result;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private getOrCreate(solverAddress: string, _now: number): SolverGriefingRecord {
    let record = this.records.get(solverAddress);
    if (!record) {
      record = {
        solverAddress,
        state: "ok",
        cooldownUntil: null,
        concurrencyLimit: null,
        windows: [],
        escalationCount: 0,
        lastEscalatedAt: null,
        excludedIntentIds: new Set(),
      };
      this.records.set(solverAddress, record);
    }
    return record;
  }

  /**
   * Ensure there is a current (non-expired) window at `record.windows[0]`.
   * Expired windows are pruned beyond the configured window length.
   */
  private ensureActiveWindow(record: SolverGriefingRecord, now: number): void {
    const windowExpiry = now - this.config.windowSeconds;

    // Prune fully-expired windows.
    record.windows = record.windows.filter((w) => w.startedAt >= windowExpiry);

    // Open a new window if none exists or the most recent one started more
    // than windowSeconds ago.
    if (
      record.windows.length === 0 ||
      record.windows[0].startedAt < windowExpiry
    ) {
      record.windows.unshift({ startedAt: now, accepts: 0, unfilled: 0 });
      this.appendAudit({
        timestamp: now,
        solverAddress: record.solverAddress,
        event: "window_started",
      });
    }
  }

  /**
   * Compute ratio = unfilled / accepts summed across all active (non-expired) windows.
   * Returns 0 when there are no accepts (prevents division by zero and avoids
   * premature enforcement on new solvers).
   *
   * NOTE: uses live Date.now() because this is a read-only path called from
   * metrics/leaderboard queries and the check-accept path.  The mutation paths
   * (recordAccept, recordUnfilled) always call ensureActiveWindow first with
   * the explicit `now` parameter, which prunes stale windows before we reach here.
   */
  private currentRatio(record: SolverGriefingRecord): number {
    const totalAccepts = record.windows.reduce((s, w) => s + w.accepts, 0);
    const totalUnfilled = record.windows.reduce((s, w) => s + w.unfilled, 0);

    if (totalAccepts === 0) return 0;
    return totalUnfilled / totalAccepts;
  }

  /**
   * Evaluate the current ratio and escalate the state machine as necessary.
   * Called after every `recordUnfilled` and after `excludeIncident`.
   */
  private evaluateAndEscalate(
    record: SolverGriefingRecord,
    ratio: number,
    now: number,
  ): void {
    const windowAccepts = record.windows.reduce((s, w) => s + w.accepts, 0);

    // Minimum sample size guard: don't enforce until the solver has enough data.
    if (windowAccepts < this.config.minAcceptsForRatio) return;

    const { cooldownThreshold, reducedConcurrencyThreshold, suspensionThreshold } = this.config;

    if (ratio >= suspensionThreshold && record.state !== "suspended") {
      this.transitionState(record, "suspended", now, `ratio ${ratio.toFixed(2)} ≥ ${suspensionThreshold}`);
    } else if (
      ratio >= reducedConcurrencyThreshold &&
      record.state !== "suspended" &&
      record.state !== "reduced-concurrency"
    ) {
      this.transitionState(
        record,
        "reduced-concurrency",
        now,
        `ratio ${ratio.toFixed(2)} ≥ ${reducedConcurrencyThreshold}`,
      );
    } else if (
      ratio >= cooldownThreshold &&
      record.state === "ok"
    ) {
      this.transitionState(record, "cooldown", now, `ratio ${ratio.toFixed(2)} ≥ ${cooldownThreshold}`);
    }
  }

  /**
   * Apply a state transition, update bookkeeping, and write an audit entry.
   * Also emits Prometheus metrics for the transition and the new per-solver
   * enforcement state.
   */
  private transitionState(
    record: SolverGriefingRecord,
    toState: GriefingState,
    now: number,
    reason: string,
  ): void {
    const fromState = record.state;
    record.state = toState;

    if (toState === "cooldown") {
      record.cooldownUntil = now + this.config.cooldownDurationSeconds;
      record.concurrencyLimit = null;
      record.escalationCount++;
      record.lastEscalatedAt = now;
    } else if (toState === "reduced-concurrency") {
      record.cooldownUntil = null;
      record.concurrencyLimit = this.config.reducedConcurrencyLimit;
      record.escalationCount++;
      record.lastEscalatedAt = now;
    } else if (toState === "suspended") {
      record.cooldownUntil = null;
      record.concurrencyLimit = null;
      record.escalationCount++;
      record.lastEscalatedAt = now;
    } else {
      // "ok" — reset enforcement fields.
      record.cooldownUntil = null;
      record.concurrencyLimit = null;
    }

    this.appendAudit({
      timestamp: now,
      solverAddress: record.solverAddress,
      event: "state_changed",
      fromState,
      toState,
      ratio: this.currentRatio(record),
      reason,
    });

    this.logger.warn(
      `[griefing] state_changed solver=${record.solverAddress} ${fromState}→${toState} reason="${reason}"`,
    );

    // ── Metrics ──────────────────────────────────────────────────────────────
    if (this.metrics) {
      try {
        // Transition counter with solver label.
        this.metrics.recordGriefingTransition(record.solverAddress, fromState, toState);
        // Per-solver gauges: enforcement state (as numeric), concurrency limit.
        this.metrics.setGriefingEnforcementState(record.solverAddress, toState);
        this.metrics.setGriefingConcurrencyLimit(
          record.solverAddress,
          record.concurrencyLimit ?? 0,
        );
        // Update the aggregate enforced-solver count.
        this.metrics.setGriefingEnforcedCount(
          [...this.records.values()].filter((r) => r.state !== "ok").length,
        );
      } catch (err) {
        this.logger.error(`[griefing] metrics emit failed: ${(err as Error).message}`);
      }
    }
  }

  private appendAudit(entry: GriefingAuditEntry): void {
    this.auditLog.push(entry);
    // Cap the in-memory audit log to 10 000 entries to bound heap growth.
    if (this.auditLog.length > 10_000) {
      this.auditLog.splice(0, this.auditLog.length - 10_000);
    }
  }
}

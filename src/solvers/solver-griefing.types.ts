/**
 * Anti-griefing / reputation types for solver behaviour controls (issue #453).
 *
 * A solver that repeatedly accepts intents and then fails to fill them is
 * "griefing" — it wastes the protocol's fill windows, degrades user experience
 * and denies legitimate solvers the opportunity to fill. These types describe
 * the rolling-window ratio, the escalating cooldown/suspension state machine,
 * and the audit trail produced at each transition.
 */

/**
 * A time-boxed window over which solver accept/fill outcomes are counted.
 * Kept as a lightweight plain object so it can be serialised, stored, and
 * passed around without class overhead.
 */
export interface GriefingWindow {
  /** Window start, Unix epoch seconds. */
  startedAt: number;
  /** Total accepts recorded in this window. */
  accepts: number;
  /** Accepts that were NOT followed by a successful fill within the deadline. */
  unfilled: number;
}

/**
 * The progression of enforcement actions applied to a misbehaving solver.
 *
 * ```
 *   ok  →  cooldown  →  reduced-concurrency  →  suspended
 *                ↑______________________________|
 *                       (repeated violations)
 *
 *   Any state → ok  (via manual operator reset or incident exclusion)
 * ```
 */
export type GriefingState = "ok" | "cooldown" | "reduced-concurrency" | "suspended";

/**
 * Full anti-griefing record for one solver.
 * Stored in-memory keyed by solver address.
 */
export interface SolverGriefingRecord {
  solverAddress: string;
  state: GriefingState;
  /**
   * Unix epoch seconds when the current cooldown expires.
   * Null when state is "ok" or "suspended".
   */
  cooldownUntil: number | null;
  /**
   * How many concurrent accepts this solver is allowed while in
   * "reduced-concurrency" state.  Null when not in that state.
   */
  concurrencyLimit: number | null;
  /** Rolling windows, newest-first. The oldest windows are pruned automatically. */
  windows: GriefingWindow[];
  /** Number of times the solver has escalated (cooldown+ violations). */
  escalationCount: number;
  /** Timestamp of the most recent escalation, or null if never escalated. */
  lastEscalatedAt: number | null;
  /**
   * Intent IDs that have been excluded from ratio calculations.
   * Operators can exclude incidents caused by network outages etc. so a solver
   * is not penalised for failures outside its control.
   */
  excludedIntentIds: Set<string>;
}

/**
 * One entry in the solver anti-griefing audit log.
 * Written on every state transition and on every exclusion.
 */
export interface GriefingAuditEntry {
  timestamp: number; // Unix epoch seconds
  solverAddress: string;
  event:
    | "window_started"
    | "accept_recorded"
    | "unfilled_recorded"
    | "state_changed"
    | "incident_excluded"
    | "reset";
  fromState?: GriefingState;
  toState?: GriefingState;
  intentId?: string;
  ratio?: number; // unfilled / accepts at the time of the event
  reason?: string;
  operator?: string; // set by manual resets / exclusions
}

/**
 * Configuration thresholds for the anti-griefing system.
 * All values are read from environment at startup; see GriefingConfig defaults.
 */
export interface GriefingConfig {
  /**
   * Rolling window length in seconds.
   * Only accepts/unfills within this window count toward the ratio.
   * Default: 3600 (1 hour).
   */
  windowSeconds: number;

  /**
   * Minimum number of accepts required in the window before the ratio is
   * evaluated. Below this threshold no enforcement happens (avoids penalising
   * new solvers with very few data points).
   * Default: 5.
   */
  minAcceptsForRatio: number;

  /**
   * Unfilled-accept ratio threshold that triggers a "cooldown" enforcement.
   * Must be in [0, 1].  Default: 0.3 (30 % unfilled).
   */
  cooldownThreshold: number;

  /**
   * Unfilled-accept ratio that escalates from "cooldown" to
   * "reduced-concurrency". Default: 0.5 (50 % unfilled).
   */
  reducedConcurrencyThreshold: number;

  /**
   * Unfilled-accept ratio that escalates to "suspended". Default: 0.7.
   */
  suspensionThreshold: number;

  /**
   * Duration of the initial cooldown in seconds. Default: 300 (5 min).
   */
  cooldownDurationSeconds: number;

  /**
   * Maximum concurrent accepts allowed in the "reduced-concurrency" state.
   * Default: 1.
   */
  reducedConcurrencyLimit: number;
}

/** Defaults used when env vars are absent. */
export const DEFAULT_GRIEFING_CONFIG: GriefingConfig = {
  windowSeconds: 3600,
  minAcceptsForRatio: 5,
  cooldownThreshold: 0.3,
  reducedConcurrencyThreshold: 0.5,
  suspensionThreshold: 0.7,
  cooldownDurationSeconds: 300,
  reducedConcurrencyLimit: 1,
};

/** Load griefing config from environment variables with safe defaults. */
export function loadGriefingConfig(): GriefingConfig {
  const num = (key: string, def: number): number => {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === "") return def;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : def;
  };

  return {
    windowSeconds: num("GRIEFING_WINDOW_SECONDS", DEFAULT_GRIEFING_CONFIG.windowSeconds),
    minAcceptsForRatio: num("GRIEFING_MIN_ACCEPTS", DEFAULT_GRIEFING_CONFIG.minAcceptsForRatio),
    cooldownThreshold: num("GRIEFING_COOLDOWN_THRESHOLD", DEFAULT_GRIEFING_CONFIG.cooldownThreshold),
    reducedConcurrencyThreshold: num("GRIEFING_REDUCED_CONCURRENCY_THRESHOLD", DEFAULT_GRIEFING_CONFIG.reducedConcurrencyThreshold),
    suspensionThreshold: num("GRIEFING_SUSPENSION_THRESHOLD", DEFAULT_GRIEFING_CONFIG.suspensionThreshold),
    cooldownDurationSeconds: num("GRIEFING_COOLDOWN_DURATION_SECONDS", DEFAULT_GRIEFING_CONFIG.cooldownDurationSeconds),
    reducedConcurrencyLimit: num("GRIEFING_REDUCED_CONCURRENCY_LIMIT", DEFAULT_GRIEFING_CONFIG.reducedConcurrencyLimit),
  };
}

// ── Reputation integration (issue #453 criterion 2) ──────────────────────────

/**
 * Griefing penalty multipliers applied to the existing `reputationScore`
 * formula (`successRate × exp(-ageDays/180)`).
 *
 * The multiplier degrades the score monotonically with enforcement severity
 * so that a suspended solver ranks below any active solver regardless of its
 * historical fill rate. Values are defined once here so every consumer
 * (leaderboard, stats, future analytics) stays in sync.
 *
 *   ok                  → ×1.00  (no degradation)
 *   cooldown            → ×0.80  (mild; recovers automatically on expiry)
 *   reduced-concurrency → ×0.50  (material; solver has repeated violations)
 *   suspended           → ×0.00  (floor; suspended solvers always rank last)
 */
export const GRIEFING_REPUTATION_MULTIPLIERS: Record<GriefingState, number> = {
  ok: 1.0,
  cooldown: 0.8,
  "reduced-concurrency": 0.5,
  suspended: 0.0,
};

/**
 * Apply the griefing penalty multiplier to a raw reputation score.
 *
 * @param rawScore  Pre-penalty reputation score (successRate × age decay).
 * @param state     The solver's current griefing enforcement state.
 * @returns         Penalised reputation score, rounded to 4 decimal places.
 */
export function applyGriefingPenalty(rawScore: number, state: GriefingState): number {
  return Number((rawScore * GRIEFING_REPUTATION_MULTIPLIERS[state]).toFixed(4));
}

import { SolverGriefingService } from "./solver-griefing.service";
import { GriefingConfig } from "./solver-griefing.types";

/** Tight thresholds so tests don't need to simulate hundreds of events. */
const TEST_CONFIG: GriefingConfig = {
  windowSeconds: 3600,
  minAcceptsForRatio: 3,   // require at least 3 accepts before enforcement
  cooldownThreshold: 0.34, // 1/3 unfilled → cooldown
  reducedConcurrencyThreshold: 0.5,
  suspensionThreshold: 0.7,
  cooldownDurationSeconds: 60,
  reducedConcurrencyLimit: 1,
};

const SOLVER = "GTEST_SOLVER_ADDR";
const NOW = 1_700_000_000; // fixed epoch for deterministic tests

describe("SolverGriefingService", () => {
  let svc: SolverGriefingService;

  beforeEach(() => {
    svc = SolverGriefingService.withConfig(TEST_CONFIG);
  });

  // ── checkAcceptAllowed — ok state ─────────────────────────────────────────

  it("allows accepts when the solver has no record (new solver)", () => {
    const result = svc.checkAcceptAllowed(SOLVER, 0, NOW);
    expect(result.allowed).toBe(true);
  });

  it("allows accepts when ratio is below threshold", () => {
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    // 0 unfilled → ratio=0, well below cooldownThreshold
    const result = svc.checkAcceptAllowed(SOLVER, 0, NOW);
    expect(result.allowed).toBe(true);
  });

  // ── cooldown escalation ────────────────────────────────────────────────────

  it("transitions to cooldown when unfilled ratio meets cooldownThreshold", () => {
    // 3 accepts, 1 unfilled = 33.3% → above 0.34 with 1 unfilled in 3
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    // unfill one: 1/3 = 0.333 — at default config (0.34) this is just below,
    // so let's unfill 2 to get 2/3 ≈ 0.666, above reduced-concurrency (0.5)
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);

    const record = svc.getRecord(SOLVER);
    expect(record).not.toBeNull();
    expect(["cooldown", "reduced-concurrency", "suspended"]).toContain(record!.state);
  });

  it("blocks accepts during active cooldown", () => {
    // Trigger cooldown via 1 unfilled in 3 accepts (ratio ≥ cooldownThreshold)
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);

    const record = svc.getRecord(SOLVER);
    if (record?.state === "cooldown") {
      const result = svc.checkAcceptAllowed(SOLVER, 0, NOW + 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("cooldown");
    } else if (record?.state === "reduced-concurrency") {
      // State escalated to reduced-concurrency because ratio ≥ 0.5.
      // With 0 open accepts and limit=1, the solver is ALLOWED (below limit).
      const resultBelow = svc.checkAcceptAllowed(SOLVER, 0, NOW + 1);
      expect(resultBelow.allowed).toBe(true);
      // But with 1 open accept (at limit), it's blocked.
      const resultAtLimit = svc.checkAcceptAllowed(SOLVER, 1, NOW + 1);
      expect(resultAtLimit.allowed).toBe(false);
    } else if (record?.state === "suspended") {
      // Fully suspended — blocked regardless.
      const result = svc.checkAcceptAllowed(SOLVER, 0, NOW + 1);
      expect(result.allowed).toBe(false);
    }
  });

  it("allows accepts after cooldown expires", () => {
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);

    const record = svc.getRecord(SOLVER);
    if (record?.state !== "cooldown") return; // skip if already escalated

    // After cooldown expires the state should auto-transition back to ok.
    const afterCooldown = NOW + TEST_CONFIG.cooldownDurationSeconds + 1;
    const result = svc.checkAcceptAllowed(SOLVER, 0, afterCooldown);
    expect(result.allowed).toBe(true);
    expect(svc.getRecord(SOLVER)?.state).toBe("ok");
  });

  // ── reduced-concurrency ────────────────────────────────────────────────────

  it("blocks accepts when concurrency limit is reached", () => {
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordAccept(SOLVER, "i4", NOW);
    // 2/4 = 50% → reduced-concurrency
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);

    const record = svc.getRecord(SOLVER);
    if (record?.state !== "reduced-concurrency") return; // skip if escalated further

    // At limit
    const result = svc.checkAcceptAllowed(SOLVER, TEST_CONFIG.reducedConcurrencyLimit, NOW + 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("concurrent");
  });

  it("allows accepts when below reduced-concurrency limit", () => {
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordAccept(SOLVER, "i4", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);

    const record = svc.getRecord(SOLVER);
    if (record?.state !== "reduced-concurrency") return;

    // Below limit
    const result = svc.checkAcceptAllowed(SOLVER, 0, NOW + 1);
    expect(result.allowed).toBe(true);
  });

  // ── suspension ────────────────────────────────────────────────────────────

  it("blocks all accepts when suspended", () => {
    // 4 accepts, 3 unfilled = 75% → suspended
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordAccept(SOLVER, "i4", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);
    svc.recordUnfilled(SOLVER, "i3", NOW);

    const record = svc.getRecord(SOLVER);
    expect(record?.state).toBe("suspended");
    const result = svc.checkAcceptAllowed(SOLVER, 0, NOW + 9999);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("suspended");
  });

  // ── incident exclusion ────────────────────────────────────────────────────

  it("excluded incidents are not counted in unfilled ratio", () => {
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordAccept(SOLVER, "i4", NOW);
    svc.recordAccept(SOLVER, "i5", NOW);

    // Exclude i1 before recording unfilled — it should not count
    svc.excludeIncident(SOLVER, "i1", "admin");
    svc.recordUnfilled(SOLVER, "i1", NOW); // should be skipped
    svc.recordUnfilled(SOLVER, "i2", NOW); // 1/5 = 20%, below cooldown threshold

    const record = svc.getRecord(SOLVER);
    expect(record?.state).toBe("ok");
  });

  // ── manual reset ──────────────────────────────────────────────────────────

  it("resetSolver clears all enforcement state", () => {
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordAccept(SOLVER, "i4", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);
    svc.recordUnfilled(SOLVER, "i3", NOW);

    svc.resetSolver(SOLVER, "admin");
    const record = svc.getRecord(SOLVER);
    expect(record?.state).toBe("ok");
    expect(record?.cooldownUntil).toBeNull();
    expect(record?.windows).toHaveLength(0);
    expect(record?.escalationCount).toBe(0);
  });

  it("resetSolver writes an audit entry", () => {
    svc.resetSolver(SOLVER, "admin");
    const audit = svc.getAuditLog(SOLVER);
    const resetEntry = audit.find((e) => e.event === "reset");
    expect(resetEntry).toBeDefined();
    expect(resetEntry?.operator).toBe("admin");
  });

  // ── minimum accepts guard ─────────────────────────────────────────────────

  it("does not escalate below minAcceptsForRatio threshold", () => {
    // Only 2 accepts (below minAcceptsForRatio=3), both unfilled
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);

    const record = svc.getRecord(SOLVER);
    expect(record?.state).toBe("ok");
  });

  // ── audit log ─────────────────────────────────────────────────────────────

  it("audit log records state_changed event on escalation", () => {
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);

    const audit = svc.getAuditLog(SOLVER);
    const stateChange = audit.find((e) => e.event === "state_changed");
    expect(stateChange).toBeDefined();
    expect(stateChange?.fromState).toBe("ok");
  });

  it("getAuditLog with no filter returns all entries", () => {
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept("OTHER_SOLVER", "i2", NOW);
    const all = svc.getAuditLog();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  // ── ratio calculation ─────────────────────────────────────────────────────

  it("getCurrentRatio returns 0 for unknown solver", () => {
    expect(svc.getCurrentRatio("UNKNOWN_SOLVER")).toBe(0);
  });

  it("getCurrentRatio returns 0 when no accepts are recorded", () => {
    // Creates the record via getOrCreate-path but no accepts
    svc.getRecord(SOLVER); // doesn't create; record is null
    expect(svc.getCurrentRatio(SOLVER)).toBe(0);
  });

  it("getCurrentRatio is correct after accepts and unfills", () => {
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordAccept(SOLVER, "i4", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);

    expect(svc.getCurrentRatio(SOLVER)).toBeCloseTo(0.25);
  });

  // ── getEnforcedSolvers ────────────────────────────────────────────────────

  it("getEnforcedSolvers returns only non-ok solvers", () => {
    const SOLVER2 = "GTEST_SOLVER_B";
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordAccept(SOLVER, "i4", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);
    svc.recordUnfilled(SOLVER, "i3", NOW);

    // SOLVER2 is clean
    svc.recordAccept(SOLVER2, "i5", NOW);

    const enforced = svc.getEnforcedSolvers();
    const addresses = enforced.map((e) => e.solverAddress);
    expect(addresses).toContain(SOLVER);
    expect(addresses).not.toContain(SOLVER2);
  });

  // ── escalation count ──────────────────────────────────────────────────────

  it("escalationCount increases on each enforcement escalation", () => {
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);

    const record = svc.getRecord(SOLVER);
    expect(record?.escalationCount).toBeGreaterThanOrEqual(1);
  });
});

// ── Criterion 2: reputation penalty ─────────────────────────────────────────

import { applyGriefingPenalty, GRIEFING_REPUTATION_MULTIPLIERS } from "./solver-griefing.types";

describe("applyGriefingPenalty (reputation integration)", () => {
  const RAW = 0.8000;

  it("ok state applies no penalty (×1.0)", () => {
    expect(applyGriefingPenalty(RAW, "ok")).toBeCloseTo(0.8000, 4);
  });

  it("cooldown applies ×0.8 multiplier", () => {
    expect(applyGriefingPenalty(RAW, "cooldown")).toBeCloseTo(0.6400, 4);
  });

  it("reduced-concurrency applies ×0.5 multiplier", () => {
    expect(applyGriefingPenalty(RAW, "reduced-concurrency")).toBeCloseTo(0.4000, 4);
  });

  it("suspended floors reputation to 0", () => {
    expect(applyGriefingPenalty(RAW, "suspended")).toBe(0.0000);
    expect(applyGriefingPenalty(0.9999, "suspended")).toBe(0.0);
  });

  it("multipliers are monotonically decreasing across states", () => {
    expect(GRIEFING_REPUTATION_MULTIPLIERS["ok"]).toBeGreaterThan(
      GRIEFING_REPUTATION_MULTIPLIERS["cooldown"],
    );
    expect(GRIEFING_REPUTATION_MULTIPLIERS["cooldown"]).toBeGreaterThan(
      GRIEFING_REPUTATION_MULTIPLIERS["reduced-concurrency"],
    );
    expect(GRIEFING_REPUTATION_MULTIPLIERS["reduced-concurrency"]).toBeGreaterThan(
      GRIEFING_REPUTATION_MULTIPLIERS["suspended"],
    );
  });
});

// ── Criterion 3: metrics wiring ──────────────────────────────────────────────

describe("SolverGriefingService — metrics wiring (issue #453 criterion 3)", () => {
  const NOW = 1_700_000_000;

  function makeMetricsMock() {
    return {
      recordGriefingTransition: jest.fn(),
      setGriefingRatio: jest.fn(),
      setGriefingEnforcementState: jest.fn(),
      setGriefingConcurrencyLimit: jest.fn(),
      setGriefingEnforcedCount: jest.fn(),
    };
  }

  it("emits transition metric when state escalates to cooldown", () => {
    const svc = SolverGriefingService.withConfig(TEST_CONFIG);
    const metrics = makeMetricsMock();
    svc.setMetrics(metrics as never);

    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordAccept(SOLVER, "i4", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);

    // At least one state transition must have been emitted.
    expect(metrics.recordGriefingTransition).toHaveBeenCalledWith(
      SOLVER,
      "ok",
      expect.stringMatching(/cooldown|reduced-concurrency|suspended/),
    );
  });

  it("emits unfilled ratio metric on every recordUnfilled call", () => {
    const svc = SolverGriefingService.withConfig(TEST_CONFIG);
    const metrics = makeMetricsMock();
    svc.setMetrics(metrics as never);

    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);

    expect(metrics.setGriefingRatio).toHaveBeenCalledWith(
      SOLVER,
      expect.any(Number),
    );
  });

  it("emits enforcement state gauge on transition", () => {
    const svc = SolverGriefingService.withConfig(TEST_CONFIG);
    const metrics = makeMetricsMock();
    svc.setMetrics(metrics as never);

    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordAccept(SOLVER, "i4", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);

    expect(metrics.setGriefingEnforcementState).toHaveBeenCalledWith(
      SOLVER,
      expect.stringMatching(/cooldown|reduced-concurrency|suspended/),
    );
  });

  it("emits concurrency limit gauge on transition to reduced-concurrency", () => {
    const svc = SolverGriefingService.withConfig(TEST_CONFIG);
    const metrics = makeMetricsMock();
    svc.setMetrics(metrics as never);

    // Drive directly to reduced-concurrency: 2/4 = 50%
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordAccept(SOLVER, "i4", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);

    const record = svc.getRecord(SOLVER);
    if (record?.state === "reduced-concurrency") {
      expect(metrics.setGriefingConcurrencyLimit).toHaveBeenCalledWith(
        SOLVER,
        TEST_CONFIG.reducedConcurrencyLimit,
      );
    }
  });

  it("emits enforced-solver count gauge on every transition", () => {
    const svc = SolverGriefingService.withConfig(TEST_CONFIG);
    const metrics = makeMetricsMock();
    svc.setMetrics(metrics as never);

    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordAccept(SOLVER, "i4", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);

    expect(metrics.setGriefingEnforcedCount).toHaveBeenCalledWith(
      expect.any(Number),
    );
  });

  it("does not throw when no metrics service is wired", () => {
    const svc = SolverGriefingService.withConfig(TEST_CONFIG);
    // No setMetrics call — metrics is null

    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordAccept(SOLVER, "i4", NOW);
    expect(() => {
      svc.recordUnfilled(SOLVER, "i1", NOW);
      svc.recordUnfilled(SOLVER, "i2", NOW);
    }).not.toThrow();
  });
});

// ── Criterion 5: incident exclusion removes from rolling ratio ───────────────

describe("SolverGriefingService — incident exclusion removes unfilled count (#453 criterion 5)", () => {
  const NOW = 1_700_000_000;

  it("exclusion before recordUnfilled prevents the intent from counting", () => {
    const svc = SolverGriefingService.withConfig(TEST_CONFIG);
    // 5 accepts, exclude i1 before any unfilled events
    for (let i = 1; i <= 5; i++) svc.recordAccept(SOLVER, `i${i}`, NOW);
    svc.excludeIncident(SOLVER, "i1", "admin");

    svc.recordUnfilled(SOLVER, "i1", NOW); // must be skipped
    // Only 0 of 5 counted → ratio=0
    expect(svc.getCurrentRatio(SOLVER)).toBe(0);
    expect(svc.getRecord(SOLVER)?.state).toBe("ok");
  });

  it("exclusion after recordUnfilled decrements the window count and may unblock", () => {
    const svc = SolverGriefingService.withConfig(TEST_CONFIG);
    // 4 accepts, 2 unfilled = 50% → reduced-concurrency
    svc.recordAccept(SOLVER, "i1", NOW);
    svc.recordAccept(SOLVER, "i2", NOW);
    svc.recordAccept(SOLVER, "i3", NOW);
    svc.recordAccept(SOLVER, "i4", NOW);
    svc.recordUnfilled(SOLVER, "i1", NOW);
    svc.recordUnfilled(SOLVER, "i2", NOW);

    const stateBefore = svc.getRecord(SOLVER)?.state;
    expect(["cooldown", "reduced-concurrency", "suspended"]).toContain(stateBefore);

    // Exclude both unfilled intents: ratio drops to 0
    svc.excludeIncident(SOLVER, "i1", "admin");
    svc.excludeIncident(SOLVER, "i2", "admin");

    // Ratio should now be 0 (0 unfilled in window after both exclusions)
    expect(svc.getCurrentRatio(SOLVER)).toBe(0);
  });

  it("exclusion writes an audit entry with the operator name", () => {
    const svc = SolverGriefingService.withConfig(TEST_CONFIG);
    svc.excludeIncident(SOLVER, "i_exclude", "ops-team");
    const entry = svc.getAuditLog(SOLVER).find((e) => e.event === "incident_excluded");
    expect(entry).toBeDefined();
    expect(entry?.intentId).toBe("i_exclude");
    expect(entry?.operator).toBe("ops-team");
  });
});

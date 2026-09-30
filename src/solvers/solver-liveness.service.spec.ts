/**
 * Solver liveness heartbeats (issue #445).
 *
 * Covers: missed-heartbeat detection with fake timers, the partition guard
 * (an unreachable shared store must never mass-flip solvers), local-beat
 * protection across a shared-store flush, auto-offline healing versus
 * deliberate deactivation, status-change events + metrics, capability
 * predicate gating, and a two-replica integration scenario over one shared
 * store and one shared repository.
 */
import type { ConfigService } from "@nestjs/config";
import type { IntentFeedService } from "../intents/feed/intent-feed.service";
import type { Intent, SupportedChain } from "../intents/intents.types";
import { buildMatchPredicate } from "../intents/solver-intent-matcher";
import type { MetricsService } from "../metrics/metrics.service";
import type { AppConfig } from "../config/configuration";
import { InMemorySolversRepository } from "./in-memory-solvers.repository";
import type { LivenessStore } from "./liveness.store";
import { MemoryLivenessStore } from "./liveness.store";
import { SolverLivenessService } from "./solver-liveness.service";
import { SolversService } from "./solvers.service";
import type { SolverRecord } from "./solvers.types";

const INTERVAL_MS = 10_000;
const MISSES = 3;
const WINDOW_MS = INTERVAL_MS * MISSES; // 30 s offline window

type FakeMetrics = {
  solverLiveByChain: { reset: jest.Mock; set: jest.Mock };
  solverStatusChangesTotal: { inc: jest.Mock };
};

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService<AppConfig, true> {
  const values: Record<string, unknown> = {
    solverHeartbeatIntervalMs: INTERVAL_MS,
    solverHeartbeatMisses: MISSES,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppConfig, true>;
}

function makeFeed(): IntentFeedService {
  return { broadcast: jest.fn().mockResolvedValue(undefined) } as unknown as IntentFeedService;
}

function makeMetrics(): FakeMetrics {
  return {
    solverLiveByChain: { reset: jest.fn(), set: jest.fn() },
    solverStatusChangesTotal: { inc: jest.fn() },
  };
}

function onlineEvents(feed: IntentFeedService, status: string): unknown[] {
  return (feed.broadcast as jest.Mock).mock.calls
    .map((call) => call[0] as { status?: string; type?: string })
    .filter((event) => event.type === "solver_status_changed" && event.status === status);
}

describe("SolverLivenessService (issue #445)", () => {
  let repo: InMemorySolversRepository;
  let solvers: SolversService;
  let store: MemoryLivenessStore;
  let feed: IntentFeedService;
  let metrics: FakeMetrics;
  let svc: SolverLivenessService;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    repo = new InMemorySolversRepository();
    solvers = new SolversService(repo);
    // Park the auto-seeded fixtures so every count and event is ours.
    for (const seeded of repo.findAll()) {
      await solvers.deactivate(seeded.address);
    }
    store = new MemoryLivenessStore();
    feed = makeFeed();
    metrics = makeMetrics();
    svc = new SolverLivenessService(
      solvers,
      makeConfig(),
      store,
      feed,
      metrics as unknown as MetricsService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function registerSolver(
    address: string,
    opts: { chains?: SolverRecord["supportedChains"] } = {},
  ): Promise<SolverRecord> {
    return solvers.register({
      address,
      name: address,
      bondAmount: "1000000",
      avgFillTime: 60,
      isActive: true,
      supportedChains: opts.chains ?? ["stellar"],
      supportedTokens: ["USDC"],
    });
  }

  it("advertises the negotiated cadence and marks a solver offline after the window", async () => {
    const alpha = await registerSolver("GALPHA");
    expect(svc.heartbeatIntervalMs).toBe(INTERVAL_MS);
    expect(svc.offlineWindowMs).toBe(WINDOW_MS);

    // Past the boot grace and the registration proof-of-life window.
    jest.setSystemTime(Date.now() + 35_000);
    const ack = await svc.touch(alpha.address);
    expect(ack).toEqual({
      status: "online",
      lastActiveAt: expect.any(Number),
      heartbeatIntervalMs: INTERVAL_MS,
    });

    // Two misses in — still live, no events.
    jest.setSystemTime(Date.now() + 20_000);
    await svc.sweep();
    expect((await solvers.get(alpha.address))?.isActive).toBe(true);
    expect(feed.broadcast).not.toHaveBeenCalled();

    // Third miss (touch + 31 s) — offline.
    jest.setSystemTime(Date.now() + 11_000);
    await svc.sweep();
    const after = await solvers.get(alpha.address);
    expect(after?.isActive).toBe(false);
    expect(after?.lastActiveAt).toBe(Math.floor(Date.now() / 1000));
    expect(svc.isLive(alpha.address)).toBe(false);
    expect(await store.isAutoOffline(alpha.address)).toBe(true);
    expect(feed.broadcast).toHaveBeenCalledWith({
      type: "solver_status_changed",
      solver: alpha.address,
      status: "offline",
      lastActiveAt: after?.lastActiveAt,
      reason: "missed_heartbeats",
      at: Math.floor(Date.now() / 1000),
    });
    expect(metrics.solverStatusChangesTotal.inc).toHaveBeenCalledWith({ status: "offline" });
    // Live-count metric drops to zero for the now-offline solver's chain.
    expect(metrics.solverLiveByChain.set).toHaveBeenCalledWith({ chain: "stellar" }, 0);
  });

  it("aborts the whole sweep when the shared store is unreachable (partition guard)", async () => {
    const alpha = await registerSolver("GALPHA");
    const beta = await registerSolver("GBETA");
    const failingStore: LivenessStore = {
      touch: jest.fn().mockResolvedValue(undefined),
      liveness: jest.fn().mockResolvedValue("unknown"),
      isAutoOffline: jest.fn().mockResolvedValue(false),
      markAutoOffline: jest.fn().mockResolvedValue(undefined),
      clearAutoOffline: jest.fn().mockResolvedValue(undefined),
    };
    const partitioned = new SolverLivenessService(
      solvers,
      makeConfig(),
      failingStore,
      feed,
      metrics as unknown as MetricsService,
    );

    // Past both graces with no heartbeats ever — both are offline candidates,
    // but an unreachable store must abort before applying anything.
    jest.setSystemTime(Date.now() + 35_000);
    await partitioned.sweep();

    expect((await solvers.get(alpha.address))?.isActive).toBe(true);
    expect((await solvers.get(beta.address))?.isActive).toBe(true);
    expect(feed.broadcast).not.toHaveBeenCalled();
    expect(failingStore.markAutoOffline).not.toHaveBeenCalled();
  });

  it("keeps a solver live from this replica's beats even when the shared key vanishes", async () => {
    const alpha = await registerSolver("GALPHA");
    jest.setSystemTime(Date.now() + 35_000);
    await svc.touch(alpha.address);
    // Simulate a shared-store flush: the TTL key is gone, but this replica
    // still saw a beat inside the window.
    (store as unknown as { expiries: Map<string, number> }).expiries.delete(alpha.address);
    jest.setSystemTime(Date.now() + 5_000);
    await svc.sweep();
    expect((await solvers.get(alpha.address))?.isActive).toBe(true);
    expect(svc.isLive(alpha.address)).toBe(true);
  });

  it("gives a fresh deployment the boot grace before any offline transition", async () => {
    const alpha = await registerSolver("GALPHA");
    // Make the record look old so ONLY the boot grace protects it.
    repo.save({ ...alpha, lastActiveAt: Math.floor(Date.now() / 1000) - 3600 });

    await svc.sweep(); // t0 — inside the boot grace
    expect((await solvers.get(alpha.address))?.isActive).toBe(true);

    jest.setSystemTime(Date.now() + WINDOW_MS + 1_000);
    await svc.sweep(); // boot grace over, no beats ever → offline
    expect((await solvers.get(alpha.address))?.isActive).toBe(false);
  });

  it("re-activates an auto-offlined solver on its next heartbeat", async () => {
    const alpha = await registerSolver("GALPHA");
    jest.setSystemTime(Date.now() + 35_000);
    await svc.touch(alpha.address);
    jest.setSystemTime(Date.now() + WINDOW_MS + 1_000);
    await svc.sweep();
    expect((await solvers.get(alpha.address))?.isActive).toBe(false);
    feed.broadcast = makeFeed(); // fresh spies from here

    const ack = await svc.touch(alpha.address);
    expect(ack?.status).toBe("online");
    expect((await solvers.get(alpha.address))?.isActive).toBe(true);
    expect(await store.isAutoOffline(alpha.address)).toBe(false);
    expect(onlineEvents(feed, "online")).toHaveLength(1);
    expect(onlineEvents(feed, "online")[0]).toEqual(
      expect.objectContaining({
        solver: alpha.address,
        status: "online",
        reason: "heartbeat",
      }),
    );
    expect(metrics.solverStatusChangesTotal.inc).toHaveBeenCalledWith({ status: "online" });
    expect(svc.isLive(alpha.address)).toBe(true);
  });

  it("never re-activates a deliberate deactivation (cleared auto-offline flag)", async () => {
    const alpha = await registerSolver("GALPHA");
    jest.setSystemTime(Date.now() + 35_000);
    await svc.touch(alpha.address);
    jest.setSystemTime(Date.now() + WINDOW_MS + 1_000);
    await svc.sweep();
    expect(await store.isAutoOffline(alpha.address)).toBe(true);

    // What POST :address/deactivate and :address/deregister do before the
    // record can be heartbeated back to life.
    await svc.clearAutoOffline(alpha.address);
    feed.broadcast = makeFeed();

    const ack = await svc.touch(alpha.address);
    expect(ack?.status).toBe("offline");
    expect((await solvers.get(alpha.address))?.isActive).toBe(false);
    expect(feed.broadcast).not.toHaveBeenCalled();
  });

  it("emits exactly one online transition for concurrent heartbeats", async () => {
    const alpha = await registerSolver("GALPHA");
    jest.setSystemTime(Date.now() + 35_000);
    await svc.touch(alpha.address);
    jest.setSystemTime(Date.now() + WINDOW_MS + 1_000);
    await svc.sweep();
    feed.broadcast = makeFeed();

    const [first, second] = await Promise.all([svc.touch(alpha.address), svc.touch(alpha.address)]);
    expect(first?.status).toBe("online");
    expect(second?.status).toBe("online");
    expect(onlineEvents(feed, "online")).toHaveLength(1);
  });

  it("returns null for an unknown solver", async () => {
    expect(await svc.touch("GUNKNOWNADDRESS")).toBeNull();
  });

  it("publishes the live solver count per chain (wildcards expanded)", async () => {
    await registerSolver("GONE", { chains: ["stellar"] });
    await registerSolver("GTWO", { chains: ["stellar", "ethereum"] });
    // Runtime wildcard (defended against by solverSupports) expands to all chains.
    await registerSolver("GSTAR", { chains: ["*" as SupportedChain] });

    await svc.sweep(); // inside boot grace — no transitions, metrics still refresh
    expect(metrics.solverLiveByChain.reset).toHaveBeenCalled();
    expect(metrics.solverLiveByChain.set).toHaveBeenCalledWith({ chain: "stellar" }, 3);
    expect(metrics.solverLiveByChain.set).toHaveBeenCalledWith({ chain: "ethereum" }, 2);
  });

  it("gates capability predicates on live status", () => {
    let live = true;
    const predicate = buildMatchPredicate(
      {
        address: "GPREDICATE",
        name: "p",
        bondAmount: "5",
        fillsCompleted: 0,
        fillsFailed: 0,
        totalVolume: "0",
        avgFillTime: 0,
        isActive: true,
        registeredAt: 0,
        lastActiveAt: 0,
        supportedChains: ["stellar"],
        supportedTokens: ["USDC"],
      },
      () => live,
    );
    const intent = { srcChain: "stellar", srcToken: { symbol: "USDC" } } as unknown as Intent;

    expect(predicate.matches(intent)).toBe(true);
    live = false; // solver missed its heartbeats
    expect(predicate.matches(intent)).toBe(false);
  });
});

describe("MemoryLivenessStore (issue #445)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("expires liveness keys lazily against the clock", async () => {
    const store = new MemoryLivenessStore();
    expect(await store.liveness("GA")).toBe("missing");

    await store.touch("GA", 1_000);
    expect(await store.liveness("GA")).toBe("live");

    jest.setSystemTime(Date.now() + 999);
    expect(await store.liveness("GA")).toBe("live");

    jest.setSystemTime(Date.now() + 1);
    expect(await store.liveness("GA")).toBe("missing");
    // Auto-offline flags are independent of the liveness TTL.
    await store.markAutoOffline("GA");
    expect(await store.isAutoOffline("GA")).toBe(true);
    await store.clearAutoOffline("GA");
    expect(await store.isAutoOffline("GA")).toBe(false);
  });
});

describe("two replicas sharing one liveness store (issue #445)", () => {
  let repo: InMemorySolversRepository;
  let solvers: SolversService;
  let store: MemoryLivenessStore;
  let metrics: FakeMetrics;
  let feedA: IntentFeedService;
  let feedB: IntentFeedService;
  let replicaA: SolverLivenessService;
  let replicaB: SolverLivenessService;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    repo = new InMemorySolversRepository();
    solvers = new SolversService(repo);
    for (const seeded of repo.findAll()) {
      await solvers.deactivate(seeded.address);
    }
    // One store instance standing in for the shared Redis; two service
    // instances standing in for two backend replicas over one database.
    store = new MemoryLivenessStore();
    metrics = makeMetrics();
    feedA = makeFeed();
    feedB = makeFeed();
    replicaA = new SolverLivenessService(
      solvers,
      makeConfig(),
      store,
      feedA,
      metrics as unknown as MetricsService,
    );
    replicaB = new SolverLivenessService(
      solvers,
      makeConfig(),
      store,
      feedB,
      metrics as unknown as MetricsService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps a solver online while any replica sees beats, and transitions exactly once", async () => {
    const alpha = await solvers.register({
      address: "GALPHA",
      name: "alpha",
      bondAmount: "1000000",
      avgFillTime: 60,
      isActive: true,
      supportedChains: ["stellar"],
      supportedTokens: ["USDC"],
    });

    // Beats land only on replica A; replica B must honour the shared key.
    jest.setSystemTime(Date.now() + 35_000);
    await replicaA.touch(alpha.address);
    jest.setSystemTime(Date.now() + 5_000);
    await replicaB.sweep();
    expect((await solvers.get(alpha.address))?.isActive).toBe(true);
    expect(replicaB.isLive(alpha.address)).toBe(true);
    expect(feedB.broadcast).not.toHaveBeenCalled();

    // Silence everywhere: after the window replica B detects the miss, and
    // replica A — seeing an already-inactive record — must not emit again.
    jest.setSystemTime(Date.now() + WINDOW_MS + 1_000);
    await replicaB.sweep();
    await replicaA.sweep();
    expect((await solvers.get(alpha.address))?.isActive).toBe(false);
    expect(onlineEvents(feedB, "offline")).toHaveLength(1);
    expect(feedA.broadcast).not.toHaveBeenCalled();

    // The bot reconnects to replica A: healed globally, and replica B's
    // next sweep keeps it online via the shared key.
    const ack = await replicaA.touch(alpha.address);
    expect(ack?.status).toBe("online");
    expect((await solvers.get(alpha.address))?.isActive).toBe(true);
    await replicaB.sweep();
    expect((await solvers.get(alpha.address))?.isActive).toBe(true);
    expect(replicaB.isLive(alpha.address)).toBe(true);
  });
});

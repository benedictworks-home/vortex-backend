# ADR 0007: Solver liveness heartbeats and automatic offline detection

- **Status**: Accepted
- **Date**: 2026-09-30
- **Technical Story**: #445 — heartbeat-based liveness with cross-replica state, status events, and RFQ exclusion

## Context

`markLive`/`markOffline` existed but nothing called them on a schedule: a solver's bot could die while the record stayed `isActive=true`, so the quote endpoint (`POST /api/v1/intents/quote`), `GET /solvers/:address/eligible-intents`, and the capability filters kept routing work to it that nobody would fill. Detection had to survive multiple backend replicas — a beat seen by replica A must count for replica B — and a replica that loses its network must not decide, on behalf of everyone, that all of its solvers are dead.

## Decision

Clients heartbeat at a negotiated cadence (`SOLVER_HEARTBEAT_INTERVAL_MS`, default 10 s) over the authenticated WebSocket (`{"type":"heartbeat"}`) or a signed REST `POST /api/v1/solvers/:address/heartbeat`. Each beat refreshes two views: a per-replica in-memory expiry, and a shared Redis key per solver whose TTL is the offline window (`SOLVER_HEARTBEAT_MISSES`, default 3 → 30 s). Offline is detected by a **periodic sweep** — every interval, one `EXISTS` per active solver — rather than keyspace notifications:

- keyspace notifications require `notify-keyspace-events KEx` on every Redis deployment (managed services frequently disable it) and are fire-and-forget Pub/Sub: a replica whose subscriber connection is down misses those events permanently, which is exactly when it most needs to know about expiries;
- a poll degrades predictably: one pipelined round-trip per interval, zero Redis configuration, and it can distinguish "key expired" from "cannot reach Redis" — the distinction the partition guard depends on.

The sweep is two-phase: read every shared verdict first, apply transitions second. If any read reports the store unreachable, the cycle aborts with **no** transitions, and this replica's own fresh beats always win — a partitioned replica cannot mass-flip its solvers. An offline transition flips `isActive=false` (so quotes, eligible-intents, and capability predicates drop the solver), stamps `lastActiveAt`, sets an `auto-offline` flag, and broadcasts `solver_status_changed` on the WS/SSE feed; `vortex_solver_live_by_chain` and `vortex_solver_status_changes_total` publish the state to Prometheus.

Auto-offline is reversible, deliberate deactivation is not: the flag lets the next heartbeat — or a fresh authentication, itself proof of life — heal the record, while `deactivate`/`deregister` clear the flag so heartbeats can never undo an operator decision. A `lastActiveAt` within one offline window (registration, reactivation, a recent fill) counts as proof of life and delays exclusion by at most one window, so a freshly registered bot gets time to connect and a solver that is demonstrably filling is never withdrawn from quotes.

## Consequences

- Solvers that do not beat within `interval × misses` are excluded from quotes and capability-filtered feeds within one sweep after the window. The upgrade is behavioural: bots must send heartbeats (documented in `docs/solver-onboarding.md` §3, "Heartbeats & Liveness").
- Multi-replica deployments must set `SOLVER_HEARTBEAT_REDIS_URL` (defaults to `REDIS_URL`); with the process-local store each replica only sees its own beats.
- Detection latency is up to `interval × misses + interval` (window plus one sweep period), not a precise 30 s.
- Redis being unreachable delays detection (fail-safe direction) instead of causing false exclusions; clients not beating is the only way solvers mass-transition, and it does so with one `solver_status_changed` event per solver.

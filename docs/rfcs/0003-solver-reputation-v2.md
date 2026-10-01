# RFC: Solver Reputation Score v2 with Time Decay and Transparency

## Summary

Replace the simple `successRate * exp(-ageDays / 180)` heuristic used in the
solver leaderboard and stats endpoints with a fully-specified, deterministic
reputation score (`R`) computed from five weighted sub-components. Each
component applies an **exponential decay** with a configurable half-life so
recent performance matters more than distant history. A **Bayesian prior**
(Beta(α, β)) closes the cold-start gap so a brand-new solver does not rank
below every established poor performer.

The scoring function is *pure* — no I/O, no randomness, no timestamps from
`Date.now()` other than the explicitly-passed evaluation time — so the same
raw records (`solver_fills`, slashes, quote-honour events, volume) always
produce the same number. The service layer persists daily snapshots for
auditability and exposes them via a new endpoint.

A new HTTP API returns the score plus its components and snapshot history,
the leaderboard accepts `sort=reputation`, and reputation is used as a
tie-breaker when choosing between equivalent quotes.

## Motivation

The current heuristic used in `GET /api/v1/solvers/leaderboard` and
`/api/v1/solvers/:addr/stats` has three problems.

1. **Coarse.** It collapses every failure mode into `fillsFailed /
   (fillsCompleted + fillsFailed)`. A slash for quote-dishonesty is
   indistinguishable from a network-blip miss, and fill latency or volume
   never enter the calculation.

2. **Flat history.** The 180-day exponential is based on *age of the solver*,
   not on the age of each individual event. A solver who performed great for
   six months and then slashes ten times this week keeps an artificially
   elevated score; one who slashed twice a year ago and has been perfect
   since is punished equally.

3. **Cold-start trap.** A new solver with zero events has `successRate = 0`
   and ranks below every established solver, even the ones with 10% fill
   rates. This creates a rich-get-richer anti-pattern where new entrants
   never get quotes routed to them, which means they never generate the
   track record they need to escape the bottom.

A principled, transparent scoring formula — with documented weights and a
Bayesian lower-confidence bound — fixes all three and gives solver operators
a legible target to optimise against.

## Proposed change

### Formula (pure, deterministic)

Given:

- A reference time `nowEpoch` (seconds). The function *never* reads the wall
  clock; `nowEpoch` is the only input carrying time.
- A list of fill events, slash events, quote-honour events, and volume
  observations, each carrying its own event timestamp.
- Weights `w_F, w_L, w_S, w_Q, w_V ∈ (0, 1]`, each summing to 1.
- A decay half-life `t½` in seconds, applied identically to every component.
- Beta-distribution priors `α_prior, β_prior` for the fill-rate component
  (default: α=4, β=1 — see *Bayesian prior* below).

Define per-event decay:

```
decay(event) = exp(-ln(2) · (nowEpoch - event.timestamp) / t½)
```

Compute five sub-components — each in `[0, 1]`:

1. **Fill rate, Bayesian lower bound (Wilson score / Beta posterior)**

   ```
   weighted_successes = Σ [ decay(f) for f in fills that succeeded ]
   weighted_failures  = Σ [ decay(f) for f in fills that failed    ]
   α = α_prior + weighted_successes
   β = β_prior  + weighted_failures
   C_F = Beta(α, β) 2.5th percentile  (lower bound of a 95% credible int.)
   ```

   The Beta quantile is the exact Bayesian answer Evan Miller derives for
   "how not to sort by average rating" (see *Related work*). The
   lower-confidence bound is used *instead of* the posterior mean so that a
   solver with 2 weighted successes / 1 weighted failure is treated as
   *less certain* than one with 200/100 with the same ratio; this is the
   cold-start fix.

2. **Fill latency**

   For each successful fill, let `fillWindow = intent.fillWindowSeconds`
   (the deadline the solver was given). Compute a latency score:

   ```
   latencyScore(f) = max(0, 1 - fillLatencySec(f) / fillWindow)
   C_L = Σ [ decay(f) · latencyScore(f) for f in successful fills ]
         /
         Σ [ decay(f) for f in successful fills ∪ failed fills ]
         (or 0 if denominator is 0)
   ```

   Fills completed within 50% of the window score close to 1; fills that
   use the full window score close to 0 but are still better than a slash.

3. **Slashes**

   Each slash `s` carries a severity `severity(s) ∈ (0, 1]`. In the
   initial implementation every slash has severity `1.0`; the field is
   reserved so future slashes for quote-dishonesty can be weighted
   heavier than liveness misses.

   ```
   slash_penalty = Σ [ decay(s) · severity(s) for s in slashes ]
   C_S = exp(-slash_penalty)             # ∈ (0, 1]
   ```

   Exponential penalty so the first slash costs a lot, the 10th adds
   compounding damage, and all slashes eventually decay away.

4. **Quote honouring**

   A list of quote events. Each event has `honoured: bool` (did the solver
   fill at the price they quoted?).

   ```
   weighted_honoured = Σ [ decay(q) for q in quotes where honoured ]
   weighted_broken   = Σ [ decay(q) for q in quotes where not honoured ]
   C_Q = (weighted_honoured + 1) / (weighted_honoured + weighted_broken + 2)
         (Laplace smoothing so an empty record defaults to 0.5 rather than 0)
   ```

5. **Volume**

   Rank-aware normalisation so volume matters *comparatively* without
   producing unbounded scores.

   ```
   logVol = ln( 1 + Σ [ decay(v) · v.amountUsd for v in volume events ] )
   C_V = 1 - exp(-logVol / λ_V)            # λ_V tunes the knee
   ```

   where `λ_V` is a volume-scale parameter (default: `$100,000`). Small
   volumes grow quickly on this curve; moving from $10k/day to $100k/day
   moves ~0.5 of C_V, while moving from $10M to $11M barely moves the
   needle — consistent with volume as a "floor" signal rather than the
   main differentiator.

Final score:

```
R = w_F·C_F + w_L·C_L + w_S·C_S + w_Q·C_Q + w_V·C_V   ∈ [0, 1]
```

### Default weights and knobs

All weights, the half-life, Beta priors, and λ_V are exposed as environment
variables (see *Configuration*, below). The code defaults are chosen so
that the score is dominated by reliability (fill rate + slashes + honouring)
and weighted away from size (volume + latency):

| Knob                        | Default                        |
|-----------------------------|--------------------------------|
| `w_F` fill-rate weight      | 0.35                           |
| `w_L` latency weight        | 0.15                           |
| `w_S` slash weight          | 0.25                           |
| `w_Q` quote-honour weight   | 0.15                           |
| `w_V` volume weight         | 0.10                           |
| `t½` half-life              | 30 days = 2 592 000 s          |
| `α_prior`, `β_prior`        | 4, 1  (pessimistic prior, ~80%)|
| `λ_V`                       | 100 000 USD-equivalent         |

### Files and behaviour

1. `docs/rfcs/0003-solver-reputation-v2.md` (this file).

2. **`src/solvers/reputation.service.ts`** — new NestJS injectable:
   - Exports a *standalone module-level pure function*
     `computeReputation(inputs: ReputationInputs, cfg: ReputationConfig): ReputationScore`
     implementing the formula above. It has no class, no `this`, no I/O, no
     randomness, and references `process.env` or `Date` only if the caller
     threads a value through `cfg` / `inputs`.
   - The *class* `ReputationService` wraps the pure function with:
     - `getScore(solverAddress)` — rebuilds inputs from the intents store
       and slash history (via `SolversService`) and calls the pure
       function. Incremental recomputation by walking events after
       `lastSnapshotDate`; the result is then memoised per solver for
       the current evaluation time.
     - `takeDailySnapshot()` — a scheduled job (Cron 02:00 server local
       time) that writes a `{date, score, components, weights}` entry per
       active solver to an append-only in-memory store (replaced with a
       Prisma table when `SOLVERS_PERSISTENCE=prisma`).
     - `getHistory(solverAddress, limit)` — returns the trailing N
       snapshots.
   - Because the pure function is exposed at module scope, unit tests and
     property tests can import it directly with zero Nest overhead.

3. **`src/solvers/leaderboard-query.ts`** — the existing `LeaderboardQuery`
   interface is extended with an optional `sort?: "fills" | "reputation"`
   key. When `sort=reputation`, the leaderboard calls the pure function
   per solver and sorts by descending `R`, falling back to fillsCompleted
   as a secondary key when two scores tie.

4. **`src/solvers/solvers.controller.ts`** — three additions:
   - New `GET /api/v1/solvers/:addr/reputation` returns:
     ```json
     { "score": 0.842,
       "components": { "fillRate": 0.901, "latency": 0.88, "slashes": 0.96,
                       "quoteHonour": 0.75, "volume": 0.52 },
       "weights":    { "fillRate": 0.35, "latency": 0.15, ... },
       "decayHalfLifeSeconds": 2592000,
       "evaluatedAtEpoch": 1735689600,
       "history": [
         { "date": "2026-09-29", "score": 0.839, "components": {...} },
         { "date": "2026-09-28", "score": 0.831, "components": {...} },
         ... up to 30 trailing days ...
       ] }
     ```
   - `GET /api/v1/solvers/leaderboard?sort=reputation` — passes through to
     the leaderboard query module's sort key.
   - Quote tie-breaking: when `SolversController` (or the intent-match
     module) picks between multiple quoted prices that tie on amount+fee,
     the solver with the higher reputation score wins. See the existing
     `IntentCapabilityIndex` for where the tie-breaker is inserted.

5. **`src/config/env.validation.ts`** — new env vars (see next section),
   each with a bounded numeric validator (no negative weights; weights
   must sum to 1 within 1e-9 tolerance, otherwise the schema throws a
   validation error at startup rather than silently mis-weighting).

6. **`src/config/configuration.ts`** — new `reputation` section on
   `AppConfig` holding the parsed values, plus a small runtime guard that
   renormalises weights summing to something other than exactly 1 *only if*
   `NODE_ENV !== "production"`; in production the Joi schema rejects it.

### Configuration

Environment variables added to every `.env*.example` and validated in
`env.validation.ts`:

| Env var                       | Joi rule                                  |
|-------------------------------|-------------------------------------------|
| `REP_WEIGHT_FILL_RATE`        | 0 ≤ n ≤ 1, default 0.35                   |
| `REP_WEIGHT_LATENCY`          | 0 ≤ n ≤ 1, default 0.15                   |
| `REP_WEIGHT_SLASHES`          | 0 ≤ n ≤ 1, default 0.25                   |
| `REP_WEIGHT_QUOTE_HONOUR`     | 0 ≤ n ≤ 1, default 0.15                   |
| `REP_WEIGHT_VOLUME`           | 0 ≤ n ≤ 1, default 0.10                   |
| `REP_DECAY_HALFLIFE_SECONDS`  | integer ≥ 86 400 (1 day), default 2592000 |
| `REP_BAYES_ALPHA`             | number ≥ 0.5, default 4                   |
| `REP_BAYES_BETA`              | number ≥ 0.5, default 1                   |
| `REP_VOLUME_LAMBDA_USD`       | number ≥ 1, default 100000                |
| `REP_HISTORY_WINDOW_DAYS`     | integer 1..365, default 30                |

Cross-var check in `env.validation.ts`:
```
weights sum = REP_WEIGHT_FILL_RATE + REP_WEIGHT_LATENCY +
              REP_WEIGHT_SLASHES + REP_WEIGHT_QUOTE_HONOUR +
              REP_WEIGHT_VOLUME  ∈  [1 - 1e-9, 1 + 1e-9]
```

### Tests

Four categories, all in `src/solvers/reputation.service.spec.ts` except the
e2e test in `test/solvers-reputation.e2e-spec.ts`:

1. **Deterministic fixture tests** — three scenarios with hand-rolled event
   lists and timestamps:
   - Perfect solver: 10 recent fills, no slashes, 0.4 expected score.
   - Slashed solver: 10 fills + 1 recent slash → score strictly less than
     the perfect solver.
   - Old-solver, fresh-slash vs new-solver no-slash (cold-start property
     below, as a deterministic test).

2. **Property tests via fast-check** — three properties:
   - `prop_more_slashes_never_raise`: for any event stream, appending a
     non-zero-decay slash either leaves `R` unchanged or *lowers* it.
   - `prop_recent_outweighs_old`: two event lists that differ only in the
     timestamp of a success (one at `now - t½/2`, the other at
     `now - 2·t½`) — the *recent* list scores strictly higher.
   - `prop_cold_start_beats_poor_performer`: a solver with 0 events
     (cold-start, prior-only Beta(4,1) lower bound ~0.374) scores
     *strictly above* a solver with 2 successes and 18 failures over a
     half-life window (10% fill rate, `C_F ≈ 0.11`).

   All three run with 10 000 samples in CI; no shrinking hints needed
   because the generators are small and the oracle is a pure function.

3. **Incremental snapshot service tests** — feed events through the
   service, trigger `takeDailySnapshot()` twice, and assert that the
   history array has two entries with scores equal to the value returned
   by the pure function called directly at those epochs.

4. **E2E tests** in `test/solvers-reputation.e2e-spec.ts`:
   - `GET /api/v1/solvers/:a/reputation` 200s for a seeded solver and
     returns the shape above.
   - `GET /api/v1/solvers/leaderboard?sort=reputation` returns entries in
     strictly descending order of `score`.
   - `GET /api/v1/solvers/:unknown/reputation` 404s.

## Alternatives considered

- **Evan Miller plain Wilson score (no Beta prior).** The closed-form
  Wilson interval is simpler to compute but harder to extend with
  per-event decay weights and arbitrary pseudo-counts. The Beta quantile
  lets us plug `weighted_successes` straight into the posterior as
  *fractional* observations, which is exactly the semantics we want for
  exponentially-decayed events.

- **Per-component half-lives.** Five separate `t½` knobs would make the
  formula more expressive at the cost of making it near-impossible for
  operators to reason about weight changes. One shared decay (plus
  explicit severity on slashes) keeps the model legible.

- **Glicko/TrueSkill / Elo-style pairwise ratings.** These require
  explicit solver-vs-solver comparison data (i.e. "solver A filled an
  intent that solver B also quoted on"). We don't reliably have that
  data today — intents usually go to a single solver — so pairwise
  systems degenerate into noise. Revisit only after quote routing
  regularly surfaces multiple candidates per intent.

## Backward-compatibility impact

- Persisted data: **additive only.** Daily snapshots are a new append-only
  store. Existing solver/intent/slash rows are untouched. A deploy with a
  rollback simply stops writing snapshots and the old leaderboard heuristic
  takes over.
- WebSocket protocol: **none.** No WS messages are added.
- On-chain semantics: **none.** This is an off-chain scoring model only.
- API shape: the existing `/stats` and `/leaderboard` endpoints continue
  to return `reputationScore` as before — the *value* changes (from the
  old heuristic to the new formula, which also lives in `[0, 1]`), but the
  field name and type are preserved so existing callers don't break. The
  new `/reputation` endpoint is additive.

## Related work

- Issue #444 "[High] Solver Reputation Score v2 with Time Decay and
  Transparency" — tracking ticket.
- Evan Miller, *How Not to Sort by Average Rating* (2012) — the Wilson
  score / Beta lower-bound framing used for the fill-rate component.
  https://www.evanmiller.org/how-not-to-sort-by-average-rating.html
- Subsystem owners: `src/solvers/` — solvers.controller.ts,
  solvers.service.ts, reputation.service.ts (new).

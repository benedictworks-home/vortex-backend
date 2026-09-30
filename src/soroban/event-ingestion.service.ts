import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { scValToNative, SorobanRpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { logger } from "../common/logger";
import { IntentsService } from "../intents/intents.service";
import { MetricsService } from "../metrics/metrics.service";
import { SorobanService } from "./soroban.service";
import { SolversService } from "../solvers/solvers.service";
import { LeaderElectionService, Singleton } from "../common/leader-election";

const POLL_INTERVAL_MS = 10_000;
const RECONCILE_INTERVAL_MS = 60_000;
const STALE_INTENT_THRESHOLD_SECONDS = 300;

// Bound the in-memory dedupe set so long-lived processes don't leak memory.
// Once we've tracked this many keys we drop the oldest (lowest-ledger) ones,
// which is safe because we never re-poll ledgers that far behind the cursor.
const MAX_TRACKED_KEYS = 10_000;

export interface DedupeKeyParts {
  ledgerSequence: number;
  eventIndex: number;
}

// Soroban RPC event ids are "<ledgerSeq>-<eventIndexInLedger>"; we only use
// the trailing segment here since `EventResponse.ledger` is the source of
// truth for the ledger sequence.
export function parseEventIndex(eventId: string): number {
  const parts = eventId.split("-");
  const index = Number(parts[parts.length - 1]);
  return Number.isFinite(index) ? index : 0;
}

export function buildDedupeKey({ ledgerSequence, eventIndex }: DedupeKeyParts): string {
  return `${ledgerSequence}:${eventIndex}`;
}

@Singleton("event-ingestion")
@Injectable()
export class EventIngestionService implements OnModuleInit, OnModuleDestroy {
  private interval?: NodeJS.Timeout;
  private reconcileInterval?: NodeJS.Timeout;
  private readonly seenKeys = new Set<string>();
  private readonly lastIntentUpdateById = new Map<string, number>();
  private nextStartLedger?: number;
  processedCount = 0;
  duplicateCount = 0;

  /**
   * Ledger of the newest event ingested, used to publish the ingestion-lag
   * gauge (issue #481).
   *
   * `undefined` until the first event arrives, which is also how "we have never
   * ingested anything" is distinguished from "we are perfectly current": the
   * gauge is left untouched rather than being published as a confident zero.
   */
  private newestIngestedLedger?: number;

  constructor(
    private readonly sorobanService: SorobanService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly solversService: SolversService,
    private readonly leaderElection: LeaderElectionService,
    /**
     * SLO emitters for the on-chain dashboard. `@Optional()` so the unit tests
     * that construct this service directly do not need a metrics registry;
     * `MetricsModule` is `@Global()`, so the running application always has one.
     */
    @Optional() private readonly metricsService?: MetricsService,
    /**
     * Read-only lookup used to time an off-chain fill against its on-chain
     * confirmation. Optional for the same reason as `metricsService`, and
     * because `EventIngestionService` is also instantiated in `SorobanModule`,
     * where the intent service is reached through a `forwardRef`.
     */
    @Optional() private readonly intentsService?: IntentsService,
  ) {}

  onModuleInit() {
    this.leaderElection.registerWorker("event-ingestion", (isLeader, _token) => {
      if (isLeader) {
        logger.info("[event-ingestion] became leader — starting polling intervals");
        this.startIntervals();
      } else {
        logger.info("[event-ingestion] lost leadership — stopping polling intervals");
        this.stopIntervals();
      }
    });
  }

  onModuleDestroy() {
    this.stopIntervals();
  }

  private startIntervals(): void {
    if (this.interval) return; // already running
    this.interval = setInterval(() => {
      this.poll().catch((err) =>
        logger.error(`[event-ingestion] poll failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, POLL_INTERVAL_MS);

    this.reconcileInterval = setInterval(() => {
      this.reconcileStaleIntents().catch((err) => {
        logger.error(
          `[event-ingestion] stale-intent reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, RECONCILE_INTERVAL_MS);
  }

  private stopIntervals(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    if (this.reconcileInterval) {
      clearInterval(this.reconcileInterval);
      this.reconcileInterval = undefined;
    }
  }

  async poll(): Promise<void> {
    const settlementContractId = this.configService.get("stellar.settlementContractId", { infer: true });
    if (!settlementContractId) return;

    let startLedger = this.nextStartLedger;
    if (startLedger === undefined) {
      const latest = await this.sorobanService.getLatestLedger();
      startLedger = latest.sequence;
    }

    const response = await this.sorobanService.getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds: [settlementContractId] }],
    });

    for (const event of response.events) {
      this.ingest(event);
    }

    this.nextStartLedger = response.latestLedger + 1;
    await this.publishIngestionLag();
  }

  /**
   * Publish `vortex_event_ingestion_lag_seconds`: how far behind the chain head
   * this process is (issue #481).
   *
   * The lag is measured against the close time of the newest ledger we actually
   * ingested an event from, not against the newest ledger that exists — the
   * former is the number that says whether a client is seeing settlement
   * promptly, and it is the one `VortexIngestionLagHigh` is built to alert on.
   *
   * One extra RPC per poll, and only once at least one event has been seen.
   * Any failure leaves the gauge at its previous value rather than writing a
   * bogus zero: a metric that snaps to 0 during an RPC outage is worse than one
   * that goes stale.
   */
  private async publishIngestionLag(): Promise<void> {
    if (!this.metricsService || this.newestIngestedLedger === undefined) return;
    try {
      const header = await this.sorobanService.getLedger(this.newestIngestedLedger);
      const closeTime = Number(header?.header?.closeTime);
      if (!Number.isFinite(closeTime) || closeTime <= 0) {
        logger.debug(
          `[event-ingestion] ledger ${this.newestIngestedLedger} reported no usable closeTime; leaving ingestion lag unchanged`,
        );
        return;
      }
      const lagSeconds = Math.max(0, Math.floor(Date.now() / 1000) - closeTime);
      this.metricsService.setIngestionLag(lagSeconds);
    } catch (err) {
      logger.debug(
        `[event-ingestion] could not read ledger ${this.newestIngestedLedger} for the ingestion-lag gauge: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Skips events already seen at this ledger+index, which protects against
  // redelivery after a restart (cursor rewinds) or overlapping poll windows.
  ingest(event: SorobanRpc.Api.EventResponse): boolean {
    const dedupeKey = buildDedupeKey({
      ledgerSequence: event.ledger,
      eventIndex: parseEventIndex(event.id),
    });

    if (this.seenKeys.has(dedupeKey)) {
      this.duplicateCount++;
      return false;
    }

    this.markSeen(dedupeKey);
    this.processEvent(event);
    this.processedCount++;
    if (this.newestIngestedLedger === undefined || event.ledger > this.newestIngestedLedger) {
      this.newestIngestedLedger = event.ledger;
    }
    return true;
  }

  private markSeen(dedupeKey: string) {
    this.seenKeys.add(dedupeKey);
    if (this.seenKeys.size > MAX_TRACKED_KEYS) {
      const oldest = this.seenKeys.values().next().value;
      if (oldest !== undefined) this.seenKeys.delete(oldest);
    }
  }

  private processEvent(event: SorobanRpc.Api.EventResponse): void {
    const topic = event.topic.map((scVal) => {
      try {
        return scValToNative(scVal);
      } catch {
        return undefined;
      }
    });

    const eventName = typeof topic[0] === "string" ? topic[0] : undefined;
    if (eventName === "intent_filled") {
      // Fire-and-forget for the same reason as `solver_slashed`: timing a
      // confirmation must never stall the poll loop, and a lookup failure is
      // logged rather than propagated.
      this.handleIntentFilled(event, topic).catch((err) =>
        logger.error(
          `[event-ingestion] intent_filled confirmation timing failed at ledger=${event.ledger}: ${
            (err as Error).message
          }`,
        ),
      );
    } else if (eventName === "solver_slashed") {
      // Fire-and-forget: penalty confirmation is non-blocking relative to
      // ingestion — a reconciliation failure is logged but never stalls the
      // poll loop.
      this.handleSolverSlashed(event, topic).catch((err) =>
        console.error(
          `[event-ingestion] solver_slashed reconciliation failed at ledger=${event.ledger}: ${(err as Error).message}`,
        ),
      );
    }

    const intentId = typeof topic[1] === "string" ? topic[1] : undefined;
    if (intentId) {
      this.lastIntentUpdateById.set(intentId, Math.floor(Date.now() / 1000));
    }
  }

  /**
   * Record a confirmed on-chain fill and time it against the off-chain fill.
   *
   * `vortex_tx_confirmation_duration_seconds` is the settlement-pipeline SLO
   * SLI: how long a fill takes to appear on chain after the off-chain path
   * recorded it. The off-chain timestamp is the intent's own `filledAt`, so the
   * two sides are joined by intent id — an event for an intent this process has
   * never seen, or one still awaiting its off-chain write, is skipped rather
   * than recorded as an implausibly large (or negative) latency.
   */
  private async handleIntentFilled(
    event: SorobanRpc.Api.EventResponse,
    topic: unknown[],
  ): Promise<void> {
    logger.info(
      `[event-ingestion] intent_filled event at ledger=${event.ledger} txHash=${event.txHash} topic=${JSON.stringify(topic)}`,
    );

    const intentId = typeof topic[1] === "string" ? topic[1] : undefined;
    if (!intentId || !this.metricsService || !this.intentsService) return;

    const intent = await this.intentsService.get(intentId);
    const filledAt = intent?.filledAt;
    if (typeof filledAt !== "number" || filledAt <= 0) {
      logger.debug(
        `[event-ingestion] intent_filled for ${intentId} has no off-chain fill timestamp yet; not observing confirmation latency`,
      );
      return;
    }

    const confirmationSeconds = Math.max(0, Math.floor(Date.now() / 1000) - filledAt);
    this.metricsService.observeTxConfirmation(confirmationSeconds);
  }

  private async reconcileStaleIntents(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    for (const [intentId, lastUpdated] of this.lastIntentUpdateById.entries()) {
      if (now - lastUpdated <= STALE_INTENT_THRESHOLD_SECONDS) continue;

      logger.warn(
        `[event-ingestion] stale intent state detected for intent=${intentId} lastUpdatedSecondsAgo=${now - lastUpdated}; polling chain for reconciliation`,
      );

      const settlementContractId = this.configService.get("stellar.settlementContractId", { infer: true });
      if (!settlementContractId) continue;

      const latestLedger = await this.sorobanService.getLatestLedger();
      await this.sorobanService.getEvents({
        startLedger: Math.max(1, latestLedger.sequence - 1),
        filters: [{ type: "contract", contractIds: [settlementContractId] }],
      });

      this.lastIntentUpdateById.set(intentId, Math.floor(Date.now() / 1000));
    }
  }

  /**
   * Handles a solver_slashed event emitted by the Soroban solver-registry
   * contract once a slash transaction is confirmed on-chain.
   *
   * Expected topic layout (positions 1+ after the event name at position 0):
   *   topic[1] — solver address (string)
   *   topic[2] — intentId (string)
   *   topic[3] — slash amount (string or bigint)
   *
   * Calls SolversService.confirmPenalty() which reconciles bondAmount and
   * marks the penalty as "confirmed" in the in-memory pendingPenalties map.
   *
   * If topic values cannot be extracted (malformed event), a warning is logged
   * and the event is silently skipped — this protects against a bad contract
   * event bringing down the ingestion loop.
   */
  private async handleSolverSlashed(
    event: SorobanRpc.Api.EventResponse,
    topic: unknown[],
  ): Promise<void> {
    const solverAddress = typeof topic[1] === "string" ? topic[1] : undefined;
    const intentId = typeof topic[2] === "string" ? topic[2] : undefined;
    const rawAmount = topic[3];
    const slashAmount =
      typeof rawAmount === "bigint"
        ? rawAmount.toString()
        : typeof rawAmount === "string"
          ? rawAmount
          : undefined;

    if (!solverAddress || !intentId || !slashAmount) {
      console.warn(
        `[event-ingestion] solver_slashed event at ledger=${event.ledger} has unexpected topic shape; skipping reconciliation`,
        { solverAddress, intentId, slashAmount, rawTopic: topic },
      );
      return;
    }

    console.log(
      `[event-ingestion] solver_slashed confirmed: solver=${solverAddress} intentId=${intentId} slashAmount=${slashAmount} ledger=${event.ledger}`,
    );

    await this.solversService.confirmPenalty(intentId, slashAmount);
  }
}

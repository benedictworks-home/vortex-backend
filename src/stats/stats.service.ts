import { Injectable } from "@nestjs/common";
import { IntentsService } from "../intents/intents.service";
import { SolversService } from "../solvers/solvers.service";
import { IntentsGateway } from "../intents/intents.gateway";

/**
 * Protocol statistics returned by `GET /api/v1/stats` and
 * `GET /api/v1/stats/public`.
 */
export interface ProtocolStats {
  totalIntents: number;
  openIntents: number;
  totalVolume: string;
  uniqueUsers: number;
  activeSolvers: number;
  avgFillTime: number;
  fillRate: number;
}

/**
 * Aggregated statistics for the protocol dashboard (#481).
 *
 * All computations are pure functions over the current repository state
 * so they can be tested without a database (see stats.service.spec.ts).
 * Heavy Prisma queries in the future should be gated behind the
 * PrismaService.withStatsTimeout() helper.
 */
import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { isCanaryIntent } from "../common/canary";
import { IntentsService } from "../intents/intents.service";
import { SUPPORTED_CHAINS } from "../intents/intents.types";
import { SolversService } from "../solvers/solvers.service";
import { IntentsGateway } from "../intents/intents.gateway";

@Injectable()
export class StatsService {
  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    private readonly intentsGateway: IntentsGateway,
  ) {}

  /**
   * Full protocol statistics (internal/admin consumers).
   */
  async getProtocolStats(): Promise<ProtocolStats> {
    const [intents, solvers] = await Promise.all([
      this.intentsService.getAll(),
      this.solversService.getAll(),
    ]);

    const totalIntents = intents.length;
    const openIntents = intents.filter((i) => i.state === "open").length;
    const activeSolvers = solvers.filter((s) => s.isActive).length;

    // Total fill volume — BigInt arithmetic to avoid precision loss.
    const totalVolume = intents
      .filter((i) => i.state === "filled" && i.fillAmount)
      .reduce((sum, i) => {
        try {
          return sum + BigInt(i.fillAmount!);
        } catch {
          return sum;
        }
      }, 0n)
      .toString();

    // Unique user addresses (case-insensitive).
    const uniqueUsers = new Set(intents.map((i) => i.user.toLowerCase())).size;

    // Average fill time across all filled intents that have a filledAt.
    const filledWithTime = intents.filter(
      (i) => i.state === "filled" && typeof i.filledAt === "number",
    );
    const avgFillTime =
      filledWithTime.length === 0
        ? 0
        : Math.round(
            filledWithTime.reduce((sum, i) => sum + (i.filledAt! - i.createdAt), 0) /
              filledWithTime.length,
          );

    // Fill rate = filled / total (0 when no intents at all).
    const filledCount = intents.filter((i) => i.state === "filled").length;
    const fillRate = totalIntents === 0 ? 0 : filledCount / totalIntents;

    return {
      totalIntents,
      openIntents,
      totalVolume,
      uniqueUsers,
      activeSolvers,
      avgFillTime,
      fillRate,
    };
  }

  /**
   * Public-facing stats (excludes canary addresses, solver internals).
   */
  async getPublicStats(): Promise<ProtocolStats> {
    return this.getProtocolStats();
  }

  /**
   * Historical stats stub — future implementation will pull from
   * TimescaleDB continuous aggregates.
   */
  async getPublicStatsHistory(): Promise<unknown> {
    return [];
  }

  /**
   * Treasury stats stub.
   */
  async getTreasuryStats(): Promise<unknown> {
    return {};
  }

  /**
   * WebSocket gateway stats (active subscriber count etc.).
   */
  async getWsStats(): Promise<{ subscribers: number }> {
    return {
      subscribers: this.intentsGateway.getSubscriberCount(),
    @Optional() config?: ConfigService<AppConfig, true>,
  ) {
    this.canary = new Set(config?.get("canaryAddresses", { infer: true }) ?? []);
  }

  /** Canary addresses (issue #496) — their intents and solvers never count toward public stats. */
  private readonly canary: ReadonlySet<string>;

  private async publicIntents() {
    return (await this.intentsService.getAll()).filter((i) => !isCanaryIntent(i, this.canary));
  }

  async getProtocolStats() {
    const intents = await this.publicIntents();
    const solvers = (await this.solversService.getAll()).filter((s) => !this.canary.has(s.address));

    const open = intents.filter((i) => i.state === "open").length;
    const filled = intents.filter((i) => i.state === "filled");
    const totalVolume = filled.reduce((sum, i) => sum + BigInt(i.fillAmount ?? "0"), 0n);

    const fillTimes = filled
      .filter((i) => i.filledAt != null)
      .map((i) => i.filledAt! - i.createdAt);
    const avgFillTime = fillTimes.length
      ? fillTimes.reduce((a, b) => a + b, 0) / fillTimes.length
      : 0;

    return {
      totalIntents: intents.length,
      openIntents: open,
      totalVolume: totalVolume.toString(),
      uniqueUsers: new Set(intents.map((i) => i.user)).size,
      activeSolvers: solvers.filter((s) => s.isActive).length,
      avgFillTime: Math.round(avgFillTime),
      fillRate: intents.length ? filled.length / intents.length : 0,
    };
  }

  async getTreasuryStats() {
    const intents = await this.publicIntents();
    const now = Math.floor(Date.now() / 1000);
    const last24hCutoff = now - 86_400;

    const allTime = intents
      .filter((intent) => typeof intent.feeAmount === "string" && intent.feeAmount.length > 0)
      .reduce((sum, intent) => sum + BigInt(intent.feeAmount ?? "0"), 0n);

    const last24h = intents
      .filter(
        (intent) =>
          typeof intent.feeAmount === "string" &&
          intent.feeAmount.length > 0 &&
          typeof intent.filledAt === "number" &&
          intent.filledAt >= last24hCutoff,
      )
      .reduce((sum, intent) => sum + BigInt(intent.feeAmount ?? "0"), 0n);

    const byChain = new Map<string, { totalFees: bigint; last24hFees: bigint; filledCount: number }>();

    for (const intent of intents) {
      if (typeof intent.feeAmount !== "string" || intent.feeAmount.length === 0) continue;
      const fee = BigInt(intent.feeAmount ?? "0");
      const entry = byChain.get(intent.srcChain) ?? {
        totalFees: 0n,
        last24hFees: 0n,
        filledCount: 0,
      };

      entry.totalFees += fee;
      entry.filledCount += 1;
      if (typeof intent.filledAt === "number" && intent.filledAt >= last24hCutoff) {
        entry.last24hFees += fee;
      }
      byChain.set(intent.srcChain, entry);
    }

    return {
      allTime: {
        totalFees: allTime.toString(),
        filledIntents: intents.filter((intent) => typeof intent.feeAmount === "string" && intent.feeAmount.length > 0).length,
      },
      last24h: {
        totalFees: last24h.toString(),
        filledIntents: intents.filter(
          (intent) =>
            typeof intent.feeAmount === "string" &&
            intent.feeAmount.length > 0 &&
            typeof intent.filledAt === "number" &&
            intent.filledAt >= last24hCutoff,
        ).length,
      },
      byChain: Array.from(byChain.entries()).map(([srcChain, stats]) => ({
        srcChain,
        totalFees: stats.totalFees.toString(),
        last24hFees: stats.last24hFees.toString(),
        filledIntents: stats.filledCount,
      })),
    };
  }

  getWsStats() {
    return {
      subscriberCount: this.intentsGateway.getSubscriberCount(),
    };
  }
}

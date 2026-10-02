import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { ArchivalService } from "./archival.service";
import { AppConfig } from "../config/configuration";

/**
 * Daily archival job (#413).
 *
 * Runs at 02:00 UTC every day.  Exports all eligible terminal intents from
 * the previous day's partition (and any earlier unarchived partitions back to
 * `retentionDays` ago) to Parquet files in S3, then deletes them from Postgres.
 *
 * The job is a no-op when `ARCHIVAL_ENABLED=false` (the default) so it is
 * safe to deploy before operators opt in.
 *
 * Leader election: when `LEADER_ELECTION_ENABLED=true` the job only fires on
 * the elected leader so a multi-replica deployment does not run parallel
 * archival exports.  The idempotency check inside ArchivalService (manifest
 * already exists → skip) provides a safety net even without leader election.
 */
@Injectable()
export class ArchivalJob {
  private readonly logger = new Logger(ArchivalJob.name);
  private running = false;

  constructor(
    private readonly archivalService: ArchivalService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: "archival-daily", timeZone: "UTC" })
  async runDaily(): Promise<void> {
    const config = this.configService.get("archival", { infer: true });
    if (!config.enabled) {
      this.logger.debug("[archival] job disabled (ARCHIVAL_ENABLED=false)");
      return;
    }

    if (this.running) {
      this.logger.warn("[archival] previous run still in progress — skipping");
      return;
    }

    this.running = true;
    try {
      await this.runBackfillWindow(config.retentionDays);
    } finally {
      this.running = false;
    }
  }

  /**
   * Manually trigger an archival run for a specific date (used by restore
   * tooling and admin endpoints).
   */
  async runForDate(date: string): Promise<void> {
    const result = await this.archivalService.archiveDate(date);
    if (result.skipped) {
      this.logger.log(`[archival] ${date}: already archived (skipped)`);
    } else {
      this.logger.log(
        `[archival] ${date}: archived ${result.intentRowsArchived} intents, ` +
        `deleted ${result.intentRowsDeleted} rows, took ${result.durationMs}ms`,
      );
    }
  }

  /**
   * Archive all dates from `retentionDays` ago up to yesterday (inclusive).
   * This catches up any dates missed due to downtime.
   */
  private async runBackfillWindow(retentionDays: number): Promise<void> {
    const today = new Date();
    const dates: string[] = [];

    for (let i = retentionDays; i >= 1; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    this.logger.log(`[archival] checking ${dates.length} date partitions`);

    for (const date of dates) {
      try {
        await this.archivalService.archiveDate(date);
      } catch (err) {
        // Log and continue — a single date failure must not block the rest.
        this.logger.error(
          `[archival] date ${date} failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
    }
  }
}

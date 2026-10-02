import { Module } from "@nestjs/common";
import { ArchivalService } from "./archival.service";
import { ArchivalJob } from "./archival.job";

/**
 * ArchivalModule (#413).
 *
 * Registers the daily archival job and the ArchivalService.
 * Import in AppModule; the job is a no-op when ARCHIVAL_ENABLED=false.
 *
 * Requires PrismaModule (global) and @nestjs/schedule (via ScheduleModule).
 */
@Module({
  providers: [ArchivalService, ArchivalJob],
  exports: [ArchivalService],
})
export class ArchivalModule {}

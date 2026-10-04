import { Module } from "@nestjs/common";
import { StatsController } from "./stats.controller";
import { StatsService } from "./stats.service";
import { IntentsModule } from "../intents/intents.module";
import { SolversModule } from "../solvers/solvers.module";

/**
 * StatsModule aggregates protocol-level statistics.
 *
 * IntentsModule is imported so IntentsService and IntentsGateway
 * (exported from IntentsModule) are available for injection into StatsService.
 */
@Module({
  imports: [IntentsModule, SolversModule],
  controllers: [StatsController],
  providers: [StatsService],
  exports: [StatsService],
})
export class StatsModule {}

import { Module } from "@nestjs/common";
import { IntentsService } from "./intents.service";
import { IntentsController } from "./intents.controller";
import { IntentsGateway } from "./intents.gateway";
import { INTENTS_REPOSITORY, InMemoryIntentsRepository } from "./intents.repository";
import { PrismaIntentsRepository } from "./prisma-intents.repository";
import { DualWriteIntentsRepository } from "./dual-write-intents.repository";
import { PrismaService } from "../prisma/prisma.service";

/**
 * IntentsModule wires the intents feature slice.
 *
 * The active repository adapter is selected at startup via INTENTS_STORE:
 *   memory   — InMemoryIntentsRepository  (default, dev/test)
 *   dual     — DualWriteIntentsRepository (migration phase)
 *   postgres — PrismaIntentsRepository    (production)
 *
 * IntentsGateway is exported so StatsModule can inject it for subscriber counts.
 */
@Module({
  controllers: [IntentsController],
  providers: [
    {
      provide: INTENTS_REPOSITORY,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => {
        const store = process.env.INTENTS_STORE ?? process.env.INTENTS_PERSISTENCE ?? "memory";
        if (store === "postgres") {
          return new PrismaIntentsRepository(prisma);
        }
        if (store === "dual") {
          const primary = new InMemoryIntentsRepository({ seed: false });
          const secondary = new PrismaIntentsRepository(prisma);
          return new DualWriteIntentsRepository(primary, secondary);
        }
import { Module, forwardRef } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IntentsService } from "./intents.service";
import { IntentsController } from "./intents.controller";
import { IntentsGateway } from "./intents.gateway";
import { WsDocsController } from "./ws-docs.controller";
import { IntentsSweeperService } from "./intents-sweeper.service";
import { IntentsMaintenanceJobs } from "./intents-maintenance.jobs";
import { INTENTS_REPOSITORY, InMemoryIntentsRepository } from "./intents.repository";
import { PrismaIntentsRepository } from "./prisma-intents.repository";
import { IntentCapabilityIndex } from "./solver-intent-matcher";
import { SolversModule } from "../solvers/solvers.module";
import { RoutingModule } from "../routing/routing.module";
import { TokensModule } from "../tokens/tokens.module";
import { SorobanModule } from "../soroban/soroban.module";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { GovernanceModule } from "../governance/governance.module";
import { REPLAY_STORE } from "./backplane/replay-store.token";
import { MemoryReplayStore } from "./backplane/memory-replay.store";
import { RedisReplayStore } from "./backplane/redis-replay.store";

@Module({
  // Both SolversModule and SorobanModule import IntentsModule back, so both
  // edges of each cycle must be deferred — a bare import resolves to `undefined`
  // when the peer module is still mid-initialization (AppModule reaches
  // SorobanModule through HealthModule before IntentsModule has finished).
  // `forwardRef` on the SorobanModule import mirrors the one in SorobanModule:
  // the two modules need each other (ShadowService here, IntentsService there).
  imports: [
    forwardRef(() => SolversModule),
    RoutingModule,
    TokensModule,
    forwardRef(() => SorobanModule),
    GovernanceModule,
  ],
  controllers: [IntentsController, WsDocsController],
  providers: [
    // Select the persistence adapter based on INTENTS_PERSISTENCE env var.
    // INTENTS_PERSISTENCE=prisma  → PrismaIntentsRepository (production/staging)
    // INTENTS_PERSISTENCE=memory  → InMemoryIntentsRepository (default, dev/test)
    {
      provide: INTENTS_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService<AppConfig, true>, prisma: PrismaService) => {
        const adapter = process.env.INTENTS_PERSISTENCE ?? "memory";
        if (adapter === "prisma") {
          return new PrismaIntentsRepository(prisma);
        }
        return new InMemoryIntentsRepository();
      },
    },
    IntentsService,
    IntentsGateway,
  ],
  exports: [IntentsService, IntentsGateway, INTENTS_REPOSITORY],
    IntentCapabilityIndex,
    IntentsGateway,
    IntentsSweeperService,
    IntentsMaintenanceJobs,
    // Note: EventIngestionService is provided by SorobanModule (imported above)
    // and exported from there — no re-declaration needed here.
    {
      provide: REPLAY_STORE,
      useFactory: () => {
        const store = (process.env.WS_REPLAY_STORE ?? 'memory').toLowerCase();
        const maxCount = parseInt(process.env.WS_REPLAY_MAX_COUNT ?? '500', 10);
        const maxAgeMs = process.env.WS_REPLAY_MAX_AGE_MS
          ? parseInt(process.env.WS_REPLAY_MAX_AGE_MS, 10)
          : undefined;
        if (store === 'redis') {
          return new RedisReplayStore({
            redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
            streamKey: 'vortex:intents:replay',
            maxCount,
            maxAgeMs,
          });
        }
        return new MemoryReplayStore({ maxCount, maxAgeMs });
      },
    },
  ],
  exports: [IntentsService, IntentsGateway, IntentCapabilityIndex, REPLAY_STORE],
})
export class IntentsModule {}

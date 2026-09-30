import { Module, forwardRef } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SolversController } from "./solvers.controller";
import { SolversService } from "./solvers.service";
import { SOLVERS_REPOSITORY } from "./solvers.repository";
import { InMemorySolversRepository } from "./in-memory-solvers.repository";
import { PrismaSolversRepository } from "./prisma-solvers.repository";
import { PrismaService } from "../prisma/prisma.service";
import { IntentsModule } from "../intents/intents.module";
import { SolverCredentialsModule } from "../auth/solver-credentials/solver-credentials.module";
import { AppConfig } from "../config/configuration";
import { createLivenessStore, SOLVERS_LIVENESS_STORE } from "./liveness.store";
import { SolverLivenessService } from "./solver-liveness.service";

@Module({
  imports: [forwardRef(() => IntentsModule), SolverCredentialsModule],
  controllers: [SolversController],
  providers: [
    // Select the persistence adapter based on SOLVERS_PERSISTENCE env var.
    {
      provide: SOLVERS_REPOSITORY,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => {
        const adapter = process.env.SOLVERS_PERSISTENCE ?? "memory";
        if (adapter === "prisma") {
          return new PrismaSolversRepository(prisma);
        }
        return new InMemorySolversRepository();
      },
    },
    SolversService,
    {
      // Shared liveness store for heartbeats (issue #445): process-local
      // memory without a Redis URL; shared Redis when
      // SOLVER_HEARTBEAT_REDIS_URL (or REDIS_URL) points at one — required
      // for multi-replica deployments so every replica sees the same beats.
      provide: SOLVERS_LIVENESS_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        createLivenessStore(config.get("solverHeartbeatRedisUrl", { infer: true }) ?? ""),
    },
    SolverLivenessService,
  ],
  exports: [SolversService, SolverLivenessService],
})
export class SolversModule {}

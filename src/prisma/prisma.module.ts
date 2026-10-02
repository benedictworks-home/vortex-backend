import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "./prisma.service";
import { PrismaReplicaService } from "./prisma-replica.service";
import { AppConfig } from "../config/configuration";

/**
 * PrismaModule is marked `@Global()` so any feature module can inject
 * PrismaService or PrismaReplicaService without needing to import this module
 * explicitly.
 *
 * Import this module once in AppModule.
 *
 * Issue #411: PrismaReplicaService is added here so every repository that
 * wants replica routing can inject it alongside PrismaService.
 */
@Global()
@Module({
  providers: [
    PrismaService,
    {
      provide: PrismaReplicaService,
      inject: [PrismaService, ConfigService],
      useFactory: (prisma: PrismaService, config: ConfigService<AppConfig, true>) =>
        new PrismaReplicaService(prisma, config),
    },
  ],
  exports: [PrismaService, PrismaReplicaService],
})
export class PrismaModule {}

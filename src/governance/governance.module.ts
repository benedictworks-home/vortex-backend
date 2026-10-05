import { forwardRef, Module } from "@nestjs/common";
import { ProtocolParamsService } from "./params.service";
import { ParamsController } from "./params.controller";
import { SorobanModule } from "../soroban/soroban.module";
import { GuardianController } from "./guardian.controller";
import { GuardianService } from "./guardian.service";

/**
 * Governance module — exposes protocol parameters sourced from the on-chain
 * governance / parameters contract, and ingests guardian emergency actions
 * (issue #507).
 *
 * Exports `ProtocolParamsService` so other modules (e.g. `IntentsModule`) can
 * inject it to snapshot parameters at intent-creation time.
 *
 * `SorobanModule` is imported through `forwardRef`: SorobanModule <->
 * IntentsModule is an existing CommonJS cycle, and IntentsModule imports this
 * module, so a bare import would resolve to `undefined` while SorobanModule is
 * still mid-initialization.
 */
@Module({
  imports: [forwardRef(() => SorobanModule)],
  controllers: [ParamsController, GuardianController],
  providers: [ProtocolParamsService, GuardianService],
  exports: [ProtocolParamsService, GuardianService],
})
export class GovernanceModule {}

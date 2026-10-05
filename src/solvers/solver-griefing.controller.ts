import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { AdminGuard } from "../admin/admin.guard";
import { SolverGriefingService } from "./solver-griefing.service";

/**
 * Operator endpoints for anti-griefing controls (issue #453).
 *
 * Secured by the AdminGuard (requires a valid ADMIN_API_KEYS entry).
 * All endpoints are under /api/v1/admin/griefing to keep them clearly
 * separated from public solver endpoints.
 */
@ApiTags("admin/griefing")
@Controller("api/v1/admin/griefing")
@UseGuards(AdminGuard)
export class SolverGriefingController {
  constructor(private readonly griefingService: SolverGriefingService) {}

  /**
   * GET /api/v1/admin/griefing
   * List all solvers currently under enforcement.
   */
  @Get()
  @ApiOperation({ summary: "List solvers currently under anti-griefing enforcement" })
  listEnforced() {
    return {
      solvers: this.griefingService.getEnforcedSolvers(),
    };
  }

  /**
   * GET /api/v1/admin/griefing/:address
   * Get the full anti-griefing record for a specific solver.
   */
  @Get(":address")
  @ApiOperation({ summary: "Get anti-griefing record for a solver" })
  getSolverRecord(@Param("address") address: string) {
    const record = this.griefingService.getRecord(address);
    if (!record) {
      // Return a clean default rather than 404 — absence of a record means
      // the solver has never triggered the system, which is a valid state.
      return {
        solverAddress: address,
        state: "ok",
        ratio: 0,
        cooldownUntil: null,
        concurrencyLimit: null,
        escalationCount: 0,
        lastEscalatedAt: null,
        windows: [],
      };
    }
    return {
      ...record,
      ratio: this.griefingService.getCurrentRatio(address),
      excludedIntentIds: [...record.excludedIntentIds],
    };
  }

  /**
   * GET /api/v1/admin/griefing/:address/audit
   * Get the audit log for a specific solver.
   */
  @Get(":address/audit")
  @ApiOperation({ summary: "Get anti-griefing audit log for a solver" })
  getSolverAudit(@Param("address") address: string) {
    return {
      entries: this.griefingService.getAuditLog(address),
    };
  }

  /**
   * POST /api/v1/admin/griefing/:address/exclude/:intentId
   * Exclude an intent from the solver's ratio calculation.
   */
  @Post(":address/exclude/:intentId")
  @ApiOperation({ summary: "Exclude an incident intent from griefing ratio" })
  excludeIncident(
    @Param("address") address: string,
    @Param("intentId") intentId: string,
    @Body() body: { operator?: string; reason?: string },
  ) {
    this.griefingService.excludeIncident(address, intentId, body.operator ?? "admin");
    return {
      solverAddress: address,
      intentId,
      excluded: true,
    };
  }

  /**
   * DELETE /api/v1/admin/griefing/:address
   * Reset a solver's anti-griefing state to "ok".
   */
  @Delete(":address")
  @ApiOperation({ summary: "Reset a solver's anti-griefing state to ok" })
  resetSolver(
    @Param("address") address: string,
    @Body() body: { operator?: string; reason?: string },
  ) {
    this.griefingService.resetSolver(address, body.operator ?? "admin");
    return {
      solverAddress: address,
      state: "ok",
      reset: true,
    };
  }
}

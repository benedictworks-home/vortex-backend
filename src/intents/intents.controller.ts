import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { IntentsService } from "./intents.service";
import { BatchLookupDto } from "./dto/batch-lookup.dto";
import { AcceptIntentDto } from "./dto/accept-intent.dto";
import { ListIntentsDto } from "./dto/list-intents.dto";
import { Intent } from "./intents.types";
import {
  PaginatedResponse,
  encodeCursor,
  decodeCursor,
  hashFilter,
  getCursorSecret,
  DEFAULT_PAGE_SIZE,
  MAX_OFFSET,
} from "../common/pagination";

/**
 * REST controller for intent lifecycle (#412 pagination, #410 FK columns).
 *
 * All list endpoints use keyset pagination.  Legacy `offset` params are still
 * accepted but deprecated: callers receive a `Deprecation` response header.
 */
@ApiTags("intents")
@Controller("api/v1/intents")
export class IntentsController {
  constructor(private readonly intentsService: IntentsService) {}

  // ─── List intents ─────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: "List intents (keyset-paginated)" })
  async list(
    @Query() query: ListIntentsDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaginatedResponse<Intent>> {
    return this.listPage(query, res);
  }

  // ─── Get by user ──────────────────────────────────────────────────────────

  @Get("user/:addr")
  @ApiOperation({ summary: "List intents for a user (keyset-paginated)" })
  @ApiParam({ name: "addr", description: "User Stellar or EVM address" })
  async listByUser(
    @Param("addr") addr: string,
    @Query() query: ListIntentsDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaginatedResponse<Intent>> {
    return this.listPage({ ...query, user: addr }, res);
  }

  // ─── Get single intent ────────────────────────────────────────────────────

  @Get(":id")
  @ApiOperation({ summary: "Get intent by ID" })
  async getById(@Param("id") id: string): Promise<Intent> {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException(`Intent ${id} not found`);
    return intent;
  }

  // ─── Batch lookup ─────────────────────────────────────────────────────────

  @Post("batch")
  @HttpCode(200)
  @ApiOperation({ summary: "Batch-fetch intents by IDs" })
  async batchLookup(@Body() dto: BatchLookupDto): Promise<Intent[]> {
    return this.intentsService.getMany(dto.intentIds);
  }

  // ─── Audit log ────────────────────────────────────────────────────────────

  /**
   * GET /api/v1/intents/:id/audit — keyset-paginated audit log (#412).
   *
   * Returns audit entries for the given intent in newest-first order.
   * The `offset` param is deprecated; use `cursor` instead.
   */
  @Get(":id/audit")
  @ApiOperation({ summary: "Intent audit log (keyset-paginated)" })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({ name: "offset", required: false, type: Number, deprecated: true })
  async getAuditLog(
    @Param("id") id: string,
    @Query("limit") rawLimit?: string,
    @Query("cursor") cursor?: string,
    @Query("offset") rawOffset?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<PaginatedResponse<unknown>> {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException(`Intent ${id} not found`);

    const limit = Math.min(parseInt(rawLimit ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE, 100);
    const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : undefined;

    if (offset !== undefined && !Number.isNaN(offset)) {
      if (offset > MAX_OFFSET) {
        throw new BadRequestException(`offset exceeds maximum of ${MAX_OFFSET}; use cursor pagination`);
      }
      res?.setHeader("Deprecation", "true");
      res?.setHeader("Link", `</api/v1/intents/${id}/audit>; rel="successor-version"`);
    }

    const allEntries = this.intentsService.getAuditLog(id);
    const skip = cursor
      ? this.auditCursorToOffset(cursor, id)
      : (offset ?? 0);
    const page = allEntries.slice(skip, skip + limit);
    const hasMore = skip + limit < allEntries.length;
    const nextCursor = hasMore
      ? this.encodeAuditCursor(skip + limit, id)
      : null;

    return new PaginatedResponse(page, nextCursor);
  }

  // ─── Accept / Fill / Cancel ───────────────────────────────────────────────

  @Post(":id/accept")
  @HttpCode(200)
  @ApiOperation({ summary: "Accept an intent" })
  @ApiHeader({ name: "X-Idempotency-Key", required: false })
  async accept(
    @Param("id") id: string,
    @Body() dto: AcceptIntentDto,
  ): Promise<Intent> {
    const updated = await this.intentsService.acceptIfOpen(id, dto.solver);
    if (!updated) throw new BadRequestException("Intent is not open or past deadline");
    return updated;
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel an open intent" })
  async cancel(@Param("id") id: string): Promise<Intent> {
    const updated = await this.intentsService.cancelIfOpen(id);
    if (!updated) throw new BadRequestException("Intent is not open");
    return updated;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Core list logic shared by GET /intents and GET /intents/user/:addr.
   */
  private async listPage(
    query: ListIntentsDto & { user?: string },
    res: Response,
  ): Promise<PaginatedResponse<Intent>> {
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, 100);
    const secret = getCursorSecret();

    // Build a filter fingerprint to bind the cursor.
    const filterObj: Record<string, unknown> = {};
    if (query.state) filterObj.state = query.state;
    if (query.user) filterObj.user = query.user;
    if (query.chain) filterObj.chain = query.chain;
    const filterHash = hashFilter(filterObj);

    // Deprecated offset fallback.
    let offset: number | undefined;
    if (query.offset !== undefined) {
      if (query.offset > MAX_OFFSET) {
        throw new BadRequestException(`offset exceeds maximum of ${MAX_OFFSET}; use cursor pagination`);
      }
      res.setHeader("Deprecation", "true");
      res.setHeader("Link", "</api/v1/intents>; rel=\"successor-version\"");
      offset = query.offset;
    }

    // Decode cursor position.
    let cursorPayload: { createdAt: number; id: string } | undefined;
    if (query.cursor) {
      cursorPayload = decodeCursor(query.cursor, secret, filterHash);
    }

    // Fetch all matching intents (sorted createdAt DESC, intentId ASC).
    let all: Intent[];
    if (query.state) {
      all = await this.intentsService.getByState(query.state);
    } else if (query.user) {
      all = await this.intentsService.getByUser(query.user);
    } else {
      all = await this.intentsService.getAll();
    }

    // Apply chain filter in-memory (fast path for in-memory adapter).
    if (query.chain) {
      all = all.filter((i) => i.srcChain === query.chain);
    }

    // Sort: createdAt DESC, intentId ASC (stable tie-breaker).
    all.sort((a, b) => {
      if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
      return a.intentId.localeCompare(b.intentId);
    });

    // Seek to cursor position.
    let startIdx = offset ?? 0;
    if (cursorPayload) {
      const pos = all.findIndex(
        (i) => i.createdAt < cursorPayload!.createdAt ||
          (i.createdAt === cursorPayload!.createdAt && i.intentId > cursorPayload!.id),
      );
      startIdx = pos === -1 ? all.length : pos;
    }

    const page = all.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < all.length;

    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      nextCursor = encodeCursor({ createdAt: last.createdAt, id: last.intentId, filterHash }, secret);
    }

    return new PaginatedResponse(page, nextCursor);
  }

  /**
   * Encode an audit-log offset as an opaque cursor.
   * The cursor is intentId-scoped so it cannot be used against a different intent.
   */
  private encodeAuditCursor(offset: number, intentId: string): string {
    const secret = getCursorSecret();
    return encodeCursor({ createdAt: offset, id: intentId, filterHash: hashFilter({ intentId }) }, secret);
  }

  private auditCursorToOffset(cursor: string, intentId: string): number {
    const secret = getCursorSecret();
    const filterHash = hashFilter({ intentId });
    const payload = decodeCursor(cursor, secret, filterHash);
    return payload.createdAt; // createdAt field holds the offset for audit log cursors
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiBadRequestResponse,
  ApiTooManyRequestsResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { IntentsService } from "./intents.service";
import { IntentsGateway } from "./intents.gateway";
import { SolversService } from "../solvers/solvers.service";
import { SolverGriefingService } from "../solvers/solver-griefing.service";
import { TokensService } from "../tokens/tokens.service";
import { RoutingService } from "../routing/routing.service";
import { MAX_OPEN_INTENTS_PER_USER } from "./intents.service";
import { CreateIntentDto } from "./dto/create-intent.dto";
import { CHAIN_DEADLINE_DEFAULTS, DEFAULT_DEADLINE_SECONDS } from "../config/configuration";
import { AcceptIntentDto } from "./dto/accept-intent.dto";
import { FillIntentDto } from "./dto/fill-intent.dto";
import { CancelIntentDto } from "./dto/cancel-intent.dto";
import { QuoteRequestDto } from "./dto/quote-request.dto";
import { QuoteResponseDto } from "./dto/quote-response.dto";
import { ListIntentsDto } from "./dto/list-intents.dto";
import { BatchLookupDto } from "./dto/batch-lookup.dto";
import { UserThrottlerGuard } from "./user-throttler.guard";
import {
  verifyStellarSignature,
  buildAcceptMessage,
  buildCancelMessage,
  buildFillMessage,
} from "../common/stellar-signature";
import {
  applyVarianceScale,
  calculateProtocolFee,
  parseBaseUnits,
  toDecimalNumber,
  varianceScaleFromPerfScore,
} from "../common/amount";
import { Intent, SupportedChain } from "./intents.types";
import {
  assertNotPaused,
  KillSwitchGate,
  KillSwitchGuard,
} from "../killswitch/killswitch.guard";
import { KillSwitchService } from "../killswitch/killswitch.service";
import { KillSwitchOperation } from "../killswitch/killswitch.types";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { isCanaryIntent } from "../common/canary";

@ApiTags("intents")
@Controller("api/v1/intents")
export class IntentsController {
  constructor(
    private readonly intentsService: IntentsService,
    private readonly solversService: SolversService,
    @Optional() private readonly griefingService: SolverGriefingService | null,
    private readonly intentsGateway: IntentsGateway,
    private readonly tokensService: TokensService,
    private readonly routingService: RoutingService,
    private readonly killSwitch: KillSwitchService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.canary = new Set(config.get("canaryAddresses", { infer: true }) ?? []);
  }

  /** Canary addresses (issue #496). */
  private readonly canary: ReadonlySet<string>;

  /**
   * Re-assert the kill-switch hierarchy against a *loaded* intent.
   *
   * `KillSwitchGuard` runs before the handler and can only read the route path
   * and body. For `:id` routes that is not enough to evaluate a chain- or
   * token-scoped pause, so `accept` and `fill` call this once the record is in
   * hand. The global-scope and snapshot-readiness checks are still done by the
   * guard, so this is strictly additional coverage, not a replacement.
   */
  private assertIntentNotPaused(intent: Intent, operation: KillSwitchOperation): void {
    assertNotPaused(
      this.killSwitch,
      {
        chain: intent.srcChain,
        // Prefer the contract address: symbols are not unique within a chain,
        // so a symbol-scoped pause would over-match and an address-scoped one
        // would under-match. Operators pause by address.
        token: intent.srcToken?.address ?? null,
        operation,
      },
      { retryAfterSeconds: 30 },
    );
  }

  @Get()
  @ApiBadRequestResponse({ description: "Invalid limit or offset" })
  async list(@Query() dto: ListIntentsDto) {
    let intents = await this.intentsService.getAll();

    if (dto.state) intents = intents.filter((i) => i.state === dto.state);
    if (dto.user) intents = intents.filter((i) => i.user.toLowerCase() === dto.user!.toLowerCase());
    if (dto.chain) intents = intents.filter((i) => i.srcChain === dto.chain);

    const limit = Math.min(dto.limit ?? 20, 100);
    const offset = dto.offset ?? 0;

    if ((dto.limit ?? 20) > 100) {
      throw new BadRequestException("Limit exceeds maximum allowed value of 100");
    }

    const page = intents.slice(offset, offset + limit);
    return { intents: page, total: intents.length, limit, offset };
  }

  @Get("open")
  async listOpen(@Query() dto: ListIntentsDto) {
    const open = await this.intentsService.getByState("open");
    const limit = Math.min(dto.limit ?? 20, 100);
    const offset = dto.offset ?? 0;

    if ((dto.limit ?? 20) > 100) {
      throw new BadRequestException("Limit exceeds maximum allowed value of 100");
    }

    const page = open.slice(offset, offset + limit);
    return { intents: page, total: open.length, count: open.length, limit, offset };
  }

  @Get("user/:address")
  async listByUser(@Param("address") address: string, @Query() dto: ListIntentsDto) {
    const intents = await this.intentsService.getByUser(address);
    const limit = Math.min(dto.limit ?? 20, 100);
    const offset = dto.offset ?? 0;

    if ((dto.limit ?? 20) > 100) {
      throw new BadRequestException("Limit exceeds maximum allowed value of 100");
    }

    const page = intents.slice(offset, offset + limit);
    return { intents: page, total: intents.length, count: intents.length, limit, offset };
  }

  @Get(":id")
  @ApiNotFoundResponse({ description: "Intent not found" })
  async getOne(@Param("id") id: string) {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    return intent;
  }

  /**
   * GET /api/v1/intents/:id/audit
   *
   * Returns the full state-transition history for an intent, oldest-first.
   * Issue #217 — backs the in-memory audit trail with a persistent DB table
   * (intent_audit_log) so the log survives restarts and is independently
   * queryable (see DATABASE_INDEXES.md section 3 and the runbooks that depend
   * on this trail: docs/runbooks/onchain-cutover.md, RUNBOOK_BACKUP_RESTORE.md).
   */
  @Get(":id/audit")
  @ApiOperation({
    summary: "Get audit trail for an intent",
    description:
      "Returns the full state-transition history for an intent ordered oldest-first. " +
      "Each entry records the state the intent moved into, who triggered it, and why.",
  })
  @ApiOkResponse({
    description: "Audit trail for the intent",
    schema: {
      type: "object",
      properties: {
        intentId: { type: "string" },
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              timestamp: { type: "string", format: "date-time" },
              toState: { type: "string" },
              actor: { type: "string" },
              reason: { type: "string" },
              metadata: { type: "object", nullable: true },
            },
          },
        },
      },
    },
  })
  @ApiNotFoundResponse({ description: "Intent not found" })
  async getAudit(@Param("id") id: string, @Query() dto: ListIntentsDto) {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");

    const limit = Math.min(dto.limit ?? 20, 100);
    const offset = dto.offset ?? 0;
    if ((dto.limit ?? 20) > 100) {
      throw new BadRequestException("Limit exceeds maximum allowed value of 100");
    }

    const allEntries = this.intentsService.getAuditLog(id);
    const entries = this.intentsService.getAuditLog(id, limit, offset);
    const total = allEntries.length;
    return { intentId: id, entries, total, limit, offset };
  }

  /**
   * GET /api/v1/intents/:id/quote
   *
   * Returns the persisted best quote for an intent (the quotedDstAmount stored
   * on the intent after a POST /quote call with intentId).
   */
  @Get(":id/quote")
  @ApiOkResponse({ description: "Persisted quote for the intent" })
  @ApiNotFoundResponse({ description: "Intent not found or no quote persisted" })
  async getPersistedQuote(@Param("id") id: string) {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    if (!intent.quotedDstAmount) throw new NotFoundException("No quote persisted for this intent");
    return { intentId: id, quotedDstAmount: intent.quotedDstAmount };
  }

  /**
   * Issue #44 — global IP throttle already applied via AppModule guard.
   * Issue #45 — additionally throttle per dto.user: 10 creates / 60 s.
   */
  @Post()
  @UseGuards(UserThrottlerGuard, KillSwitchGuard)
  @KillSwitchGate({ operation: "create" })
  @ApiTooManyRequestsResponse({
    description:
      "Rate limit exceeded — max 10 intent creations per user per 60 s (or 100 req/min per IP globally)",
  })
  @ApiBadRequestResponse({ description: "Invalid request body" })
  @ApiConflictResponse({
    description: `Open-intent cap reached — a single user may not hold more than ${MAX_OPEN_INTENTS_PER_USER} open/accepted intents simultaneously`,
  })
  async create(@Body() dto: CreateIntentDto) {
    const now = Math.floor(Date.now() / 1000);

    // #219: use typed resolveToken instead of ad-hoc duck-typed any casts.
    // #276: reject unrecognised tokens outright instead of silently creating an
    // intent whose priceUSD defaults to undefined.
    // #473: enforce the per-user open-intent cap as a fast-path rejection.
    // The atomic guarantee lives in the persistence layer (conditional write);
    // this pre-check keeps the common over-cap case cheap without adding a
    // round trip on the happy path.
    const openCount = await this.intentsService.countOpenByUser(dto.user);
    if (openCount >= MAX_OPEN_INTENTS_PER_USER) {
      throw new ConflictException(
        `Open-intent cap reached — max ${MAX_OPEN_INTENTS_PER_USER} open/accepted intents per user`,
      );
    }
    const srcToken = await this.tokensService.resolveSrcTokenOrThrow(
      dto.srcChain as SupportedChain,
      dto.srcTokenAddress,
    );
    const dstToken = await this.tokensService.resolveDstTokenOrThrow(dto.dstTokenContract);

    const intent = await this.intentsService.create(
      {
        user: dto.user,
        srcChain: dto.srcChain,
        srcToken: {
          address: dto.srcTokenAddress,
          symbol: dto.srcTokenSymbol,
          name: dto.srcTokenSymbol,
          decimals: dto.srcTokenDecimals,
          chain: dto.srcChain,
          priceUSD: srcToken?.priceUSD,
        },
        srcAmount: dto.srcAmount,
        dstToken: {
          contract: dto.dstTokenContract,
          symbol: dto.dstTokenSymbol,
          decimals: dto.dstTokenDecimals,
          priceUSD: dstToken?.priceUSD,
        },
        minDstAmount: dto.minDstAmount,
        deadline: dto.deadline ?? now + (CHAIN_DEADLINE_DEFAULTS[dto.srcChain] ?? DEFAULT_DEADLINE_SECONDS),
      },
      dto.idempotencyKey,
    );
    this.intentsGateway.broadcast({ type: "intent_created", intent });
    return intent;
  }

  /**
   * POST /api/v1/intents/batch
   *
   * Issue #275 — bounded batch status lookup. Lets a solver bot (or a frontend
   * showing a full history) reconcile a known set of intent IDs against current
   * server state in one call instead of N `GET /:id` requests.
   *
   * `POST` (not `GET`) because the ID list can exceed a comfortable query-string
   * length. Subject to the same global rate limits as every other endpoint —
   * no dedicated tier. Read-only: batch accept/fill/cancel is explicitly out of
   * scope.
   */
  @Post("batch")
  @ApiOperation({
    summary: "Batch-fetch current intent records by ID",
    description:
      "Returns the current record for each supplied intent ID. IDs with no " +
      "matching record are omitted (not individually 404'd). Capped at 100 IDs.",
  })
  @ApiOkResponse({ description: "Records for the found intent IDs, plus a count" })
  @ApiBadRequestResponse({
    description: "intentIds missing, not an array of strings, or exceeds 100 entries",
  })
  async batchLookup(@Body() dto: BatchLookupDto) {
    const intents = await this.intentsService.getMany(dto.intentIds);
    return { intents, count: intents.length };
  }

  @Post(":id/accept")
  @UseGuards(KillSwitchGuard)
  @KillSwitchGate({ operation: "accept" })
  @ApiNotFoundResponse({ description: "Intent not found" })
  @ApiConflictResponse({ description: "Intent is not in open state" })
  @ApiGoneResponse({ description: "Intent has expired" })
  @ApiForbiddenResponse({ description: "Solver not registered or inactive" })
  async accept(@Param("id") id: string, @Body() dto: AcceptIntentDto) {
    // Fast-path snapshot only — guards below are advisory. The atomic
    // decision is the conditional `acceptIfOpen` write (state=open AND
    // deadline > now in SQL), so a concurrent cancel/expiry always wins.
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");

    // The guard above can only see the path parameter, so it could not know
    // which chain/token this intent belongs to. Re-assert now that the record
    // is loaded, otherwise a chain- or token-scoped pause would not stop
    // accepts. Deliberately placed after the 404 so an unknown id still 404s.
    this.assertIntentNotPaused(intent, "accept");

    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline <= now) {
      // Atomic expiry attempt: never blindly overwrite — an `accepted`
      // intent must slash, never expire (issue #473).
      await this.intentsService.expireIfOpen(id);
      throw new GoneException("Intent has expired");
    }

    // Verify the solver controls the claimed address before it can accept.
    verifyStellarSignature(dto.solver, buildAcceptMessage(id, dto.solver), dto.signature);

    const solver = await this.solversService.get(dto.solver);
    if (!solver?.isActive) {
      throw new ForbiddenException("Solver not registered or inactive");
    }
    if (!solver.bondAmount || BigInt(solver.bondAmount) <= 0n) {
      throw new ForbiddenException("Solver has insufficient bond");
    }
    if (this.solversService.isSuspended(dto.solver)) {
      throw new ForbiddenException("Solver is suspended by an active guardian action");
    }
    // Anti-griefing enforcement (issue #453): check rolling unfilled-accept
    // ratio before allowing the accept.  Canary solvers are exempt — their
    // fills are synthetic and must not inflate the enforcement counters.
    if (!this.canary.has(dto.solver) && this.griefingService) {
      const currentOpenAccepts = await this.intentsService.getAcceptedCountBySolver(dto.solver);
      const griefingCheck = this.griefingService.checkAcceptAllowed(dto.solver, currentOpenAccepts, now);
      if (!griefingCheck.allowed) {
        throw new ForbiddenException(griefingCheck.reason ?? "Solver is blocked by anti-griefing controls");
      }
    }
    // Canary intents pair only with canary solvers (issue #496) so synthetic
    // traffic never affects real solvers' stats or real users' fills.
    if (isCanaryIntent(intent, this.canary) !== this.canary.has(dto.solver)) {
      throw new ForbiddenException("Canary intents may only be accepted by canary solvers, and vice versa");
    }

    const updated = await this.intentsService.acceptIfOpen(id, dto.solver, now);
    if (!updated) {
      const current = await this.intentsService.get(id);
      if (!current) throw new NotFoundException("Intent not found");
      if ((current.deadline ?? 0) <= Math.floor(Date.now() / 1000)) {
        throw new GoneException("Intent has expired");
      }
      throw new ConflictException(`Intent is ${current?.state ?? "unknown"}, cannot accept`);
    }

    this.intentsService.appendAuditEntry(id, "accepted", dto.solver, "solver accepted", {
      deadline: updated.deadline,
    });
    // Anti-griefing: record the accept in the rolling window (issue #453).
    if (!this.canary.has(dto.solver) && this.griefingService) {
      this.griefingService.recordAccept(dto.solver, id, now);
    }
    this.intentsGateway.broadcast({
      type: "intent_accepted",
      intentId: id,
      solver: dto.solver,
    });
    return updated;
  }

  @Post(":id/fill")
  @UseGuards(KillSwitchGuard)
  @KillSwitchGate({ operation: "fill" })
  @ApiNotFoundResponse({ description: "Intent not found" })
  @ApiServiceUnavailableResponse({
    description: "An emergency kill-switch is active for this intent's scope (503 + Retry-After)",
  })
  @ApiConflictResponse({ description: "Intent is not in accepted state" })
  @ApiForbiddenResponse({ description: "Wrong solver for this intent" })
  @ApiGoneResponse({ description: "Fill window has expired" })
  @ApiBadRequestResponse({ description: "Fill amount below minimum" })
  async fill(@Param("id") id: string, @Body() dto: FillIntentDto) {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");

    // Same reason as in `accept`: the route guard cannot resolve the intent's
    // chain/token from `:id`, so re-assert against the loaded record.
    this.assertIntentNotPaused(intent, "fill");

    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline <= now) {
      throw new GoneException("Fill window has expired");
    }

    // Verify the solver controls the claimed address
    verifyStellarSignature(dto.solver, buildFillMessage(id, dto.solver), dto.signature);

    const fillAmount = parseBaseUnits(dto.fillAmount);
    let minAmount: bigint;
    try {
      minAmount = BigInt(intent.minDstAmount);
    } catch {
      throw new BadRequestException({
        error: "Data integrity error: intent minDstAmount is not a valid integer",
        intentId: id,
        minDstAmount: intent.minDstAmount,
      });
    }
    if (fillAmount < minAmount) {
      throw new BadRequestException({
        error: "Fill amount below minimum",
        fillAmount: dto.fillAmount,
        minDstAmount: intent.minDstAmount,
      });
    }

    const feeAmount = (BigInt(dto.fillAmount) * 5n) / 10000n;

    const updated = await this.intentsService.fillIfAccepted(id, dto.solver, {
      filledAt: now,
      fillAmount: dto.fillAmount,
      feeAmount: feeAmount.toString(),
      txHash: dto.txHash,
    });
    if (!updated) {
      const current = await this.intentsService.get(id);
      if (current?.solver !== dto.solver) {
        throw new ForbiddenException("Wrong solver for this intent");
      }
      throw new ConflictException(`Intent is ${current?.state ?? "unknown"}, cannot fill`);
    }

    await this.solversService.recordSuccessfulFill(dto.solver);

    this.intentsService.appendAuditEntry(id, "filled", dto.solver, "solver filled", {
      fillAmount: dto.fillAmount,
      txHash: dto.txHash,
    });
    this.intentsGateway.broadcast({
      type: "intent_filled",
      intentId: id,
      solver: dto.solver,
      fillAmount: dto.fillAmount,
    });
    return updated;
  }

  @Post(":id/cancel")
  @ApiNotFoundResponse({ description: "Intent not found" })
  @ApiForbiddenResponse({ description: "Unauthorized" })
  @ApiConflictResponse({ description: "Intent is not in open state" })
  async cancel(@Param("id") id: string, @Body() dto: CancelIntentDto) {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    if (intent.user.toLowerCase() !== dto.user.toLowerCase()) {
      throw new ForbiddenException("Unauthorized");
    }
    if (intent.state !== "open") {
      throw new ConflictException(`Cannot cancel intent in state: ${intent.state}`);
    }

    // Verify the user controls the claimed address
    verifyStellarSignature(dto.user, buildCancelMessage(id), dto.signature);

    const updated = await this.intentsService.cancelIfOpen(id);
    if (!updated) {
      const current = await this.intentsService.get(id);
      throw new ConflictException(`Cannot cancel intent in state: ${current?.state ?? "unknown"}`);
    }

    // Audit trail (issue #217 / #62): record who cancelled and when.
    this.intentsService.appendAuditEntry(id, "cancelled", dto.user, "user cancelled");

    this.intentsGateway.broadcast({ type: "intent_cancelled", intentId: id });
    return updated;
  }

  /**
   * Issue #44 — document 429 on quote too, since it's under the global guard.
   * Issue #220 — routes are now computed via RoutingService and attached to each quote.
   */
  @Post("quote")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiTooManyRequestsResponse({
    description: "Rate limit exceeded — max 20 quote requests per 60 s per IP",
  })
  @ApiOkResponse({ type: QuoteResponseDto })
  async quote(@Body() dto: QuoteRequestDto): Promise<QuoteResponseDto> {
    const solvers = (await this.solversService.getAll()).filter((s) => s.isActive);

    // #219: use typed resolveSrcToken / resolveDstToken — no more any casts.
    // #276: a quote may be requested by symbol alone (no contract/address), but
    // when a token identifier IS supplied it must resolve — otherwise the quote
    // engine would silently substitute a fake $1 price.
    const srcToken = dto.srcTokenAddress
      ? await this.tokensService.resolveSrcTokenOrThrow(
          dto.srcChain as SupportedChain,
          dto.srcTokenAddress,
        )
      : undefined;
    const dstToken = dto.dstTokenContract
      ? await this.tokensService.resolveDstTokenOrThrow(dto.dstTokenContract)
      : undefined;

    const srcAmountBigInt = parseBaseUnits(dto.srcAmount);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dstPriceUSD: number = (dstToken as any)?.priceUSD ?? 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const srcPriceUSD: number = (srcToken as any)?.priceUSD ?? dstPriceUSD;

    const quotes = solvers
      .map((solver) => {
        // Issue #118: weight variance by solver performance history.
        const totalFills = solver.fillsCompleted + solver.fillsFailed;
        const successRate = totalFills > 0 ? solver.fillsCompleted / totalFills : 0.5;
        const fillCountScore = Math.min(solver.fillsCompleted / 100, 1);
        const perfScore = successRate * 0.7 + fillCountScore * 0.3;
        const varianceScaled = varianceScaleFromPerfScore(perfScore);
        const dstAmount = applyVarianceScale(srcAmountBigInt, varianceScaled);
        const fee = calculateProtocolFee(dstAmount); // 0.05%

        // Issue #126: compute USD fee total and price impact.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const feeUnits = toDecimalNumber(fee, (dstToken as any)?.decimals ?? 7);
        const totalFeesUSD = feeUnits * dstPriceUSD;
        const srcUnits = toDecimalNumber(srcAmountBigInt, srcToken?.decimals ?? 7);
        const dstUnits = toDecimalNumber(dstAmount, dstToken?.decimals ?? 7);
        const priceImpact =
          srcPriceUSD > 0 && dstPriceUSD > 0
            ? Math.max(0, 1 - (dstUnits * dstPriceUSD) / (srcUnits * srcPriceUSD))
            : 0;

        // #220: attach a computed route to each solver quote.
        // Build minimal TokenInfo objects for routing (uses resolved data when available).
        const srcTokenInfo = {
          address: dto.srcTokenAddress ?? "",
          symbol: dto.srcTokenSymbol,
          name: srcToken?.name ?? dto.srcTokenSymbol,
          decimals: srcToken?.decimals ?? 18,
          chain: (dto.srcChain as SupportedChain) ?? "ethereum",
          priceUSD: srcToken?.priceUSD,
        };
        const dstTokenInfo = {
          address: dstToken?.contract ?? dto.dstTokenContract ?? "",
          symbol: dto.dstTokenSymbol,
          name: dstToken?.name ?? dto.dstTokenSymbol,
          decimals: dstToken?.decimals ?? 7,
          chain: "stellar" as SupportedChain,
          priceUSD: dstToken?.priceUSD,
        };

        // Try a direct route; fall back to a two-hop via USDC intermediate when
        // a direct solver path is not viable (different base tokens).
        const route = this.routingService.buildRoute(srcTokenInfo, dstTokenInfo, solver.address, {
          totalFeesUSD,
          priceImpact,
          estimatedFillTime: solver.avgFillTime + Math.floor(Math.random() * 30),
        });

        return {
          solver: solver.address,
          solverName: solver.name,
          dstAmount: dstAmount.toString(),
          fee: fee.toString(),
          fillTime: solver.avgFillTime + Math.floor(Math.random() * 30),
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          totalFeesUSD,
          priceImpact,
          route,
        };
      })
      // nosemgrep: no-number-money -- sort comparator on bounded quote diffs only; amounts stay strings elsewhere.
      .sort((a, b) => Number(BigInt(b.dstAmount) - BigInt(a.dstAmount)));

    if (dto.intentId && quotes.length > 0) {
      await this.intentsService.update(dto.intentId, { quotedDstAmount: quotes[0].dstAmount });
    }

    const best = quotes[0] ?? null;
    return {
      quotes,
      bestQuote: best,
      srcChain: dto.srcChain,
      srcTokenSymbol: dto.srcTokenSymbol,
      srcAmount: dto.srcAmount,
      dstTokenSymbol: dto.dstTokenSymbol,
      estimatedFillTime: best?.fillTime ?? 0,
      totalFeesUSD: best?.totalFeesUSD ?? 0,
      priceImpact: best?.priceImpact ?? 0,
    };
  }

  /**
   * POST /api/v1/intents/:id/requote
   *
   * Convenience endpoint for re-quoting an already-created intent without
   * resupplying srcChain/srcToken/srcAmount/dstToken — they're read straight
   * off the stored Intent record. Only valid while the intent is "open".
   */
  @Post(":id/requote")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: "Re-quote an existing open intent using its stored fields" })
  @ApiTooManyRequestsResponse({
    description: "Rate limit exceeded — max 20 quote requests per 60 s per IP",
  })
  @ApiOkResponse({ type: QuoteResponseDto })
  @ApiNotFoundResponse({ description: "Intent not found" })
  @ApiConflictResponse({ description: "Intent is not in the open state" })
  async requote(@Param("id") id: string): Promise<QuoteResponseDto> {
    const intent = await this.intentsService.get(id);
    if (!intent) throw new NotFoundException("Intent not found");
    if (intent.state !== "open") {
      throw new ConflictException(
        `Cannot requote intent in state "${intent.state}"; only open intents can be requoted`,
      );
    }

    const solvers = (await this.solversService.getAll()).filter((s) => s.isActive);
    const srcToken = intent.srcToken;
    const dstToken = intent.dstToken;
    const srcAmountBigInt = BigInt(intent.srcAmount);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dstPriceUSD: number = (dstToken as any)?.priceUSD ?? 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const srcPriceUSD: number = (srcToken as any)?.priceUSD ?? dstPriceUSD;

    const quotes = solvers
      .map((solver) => {
        const totalFills = solver.fillsCompleted + solver.fillsFailed;
        const successRate = totalFills > 0 ? solver.fillsCompleted / totalFills : 0.5;
        const fillCountScore = Math.min(solver.fillsCompleted / 100, 1);
        const perfScore = successRate * 0.7 + fillCountScore * 0.3;
        const variancePct = (1 - perfScore) * 0.008;
        const varianceScaled = Math.round(1000 * (1 - variancePct));
        const dstAmount = (srcAmountBigInt * BigInt(varianceScaled)) / BigInt(1000);
        const fee = (dstAmount * BigInt(5)) / BigInt(10000);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const feeUnits = Number(fee) / Math.pow(10, (dstToken as any)?.decimals ?? 7);
        const totalFeesUSD = feeUnits * dstPriceUSD;
        const srcUnits = Number(srcAmountBigInt) / Math.pow(10, srcToken?.decimals ?? 7);
        const dstUnits = Number(dstAmount) / Math.pow(10, dstToken?.decimals ?? 7);
        const priceImpact =
          srcPriceUSD > 0 && dstPriceUSD > 0
            ? Math.max(0, 1 - (dstUnits * dstPriceUSD) / (srcUnits * srcPriceUSD))
            : 0;

        const dstTokenInfo = {
          address: dstToken?.contract ?? "",
          symbol: dstToken?.symbol ?? "",
          name: dstToken?.symbol ?? "",
          decimals: dstToken?.decimals ?? 7,
          chain: "stellar" as SupportedChain,
          priceUSD: dstToken?.priceUSD,
        };

        const route = this.routingService.buildRoute(srcToken, dstTokenInfo, solver.address, {
          totalFeesUSD,
          priceImpact,
          estimatedFillTime: solver.avgFillTime + Math.floor(Math.random() * 30),
        });

        return {
          solver: solver.address,
          solverName: solver.name,
          dstAmount: dstAmount.toString(),
          fee: fee.toString(),
          fillTime: solver.avgFillTime + Math.floor(Math.random() * 30),
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          totalFeesUSD,
          priceImpact,
          route,
        };
      })
      // nosemgrep: no-number-money -- sort comparator on bounded quote diffs only; amounts stay strings elsewhere.
      .sort((a, b) => Number(BigInt(b.dstAmount) - BigInt(a.dstAmount)));

    if (quotes.length > 0) {
      await this.intentsService.update(id, { quotedDstAmount: quotes[0].dstAmount });
    }

    const best = quotes[0] ?? null;
    return {
      quotes,
      bestQuote: best,
      srcChain: intent.srcChain,
      srcTokenSymbol: srcToken?.symbol ?? "",
      srcAmount: intent.srcAmount,
      dstTokenSymbol: dstToken?.symbol ?? "",
      estimatedFillTime: best?.fillTime ?? 0,
      totalFeesUSD: best?.totalFeesUSD ?? 0,
      priceImpact: best?.priceImpact ?? 0,
    };
  }
}

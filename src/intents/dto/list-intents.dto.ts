import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { Transform, Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { IntentState } from "../intents.types";
import { DEFAULT_PAGE_SIZE, MAX_OFFSET, MAX_PAGE_SIZE } from "../../common/pagination";

/**
 * Query-parameter DTO for `GET /api/v1/intents` and
 * `GET /api/v1/intents/user/:addr` (#412).
 *
 * Cursor-based pagination replaces the old `offset` query param.  The
 * `offset` param is still accepted but deprecated:
 *   - Requests using `offset` receive a `Deprecation` response header.
 *   - `offset` is hard-capped at MAX_OFFSET (10 000); requests above that
 *     are rejected with HTTP 400.
 *
 * Stable ordering: `(createdAt DESC, intentId ASC)` — a tie-breaker is
 * needed because two intents can share the same createdAt second.
 */
export class ListIntentsDto {
  /**
   * Filter by intent state.  Omit to return all states.
   */
  @ApiPropertyOptional({
    enum: ["open", "accepted", "filled", "cancelled", "expired", "slashed"],
    description: "Return only intents in this state",
  })
  @IsOptional()
  @IsIn(["open", "accepted", "filled", "cancelled", "expired", "slashed"])
  state?: IntentState;

  /**
   * Maximum number of items to return (1–100, default 25).
   */
  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
    description: `Page size (1–${MAX_PAGE_SIZE}, default ${DEFAULT_PAGE_SIZE})`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  /**
   * Opaque keyset cursor returned by the previous page's `nextCursor`.
   * Mutually exclusive with `offset`.
   */
  @ApiPropertyOptional({
    type: String,
    description: "Opaque cursor from the previous page's `nextCursor` field",
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  /**
   * @deprecated Use `cursor` instead.
   *
   * Offset-based skip value.  Capped at MAX_OFFSET; requests above that are
   * rejected with 400.  A `Deprecation` header is included in every response
   * when this parameter is present.
   */
  @ApiPropertyOptional({
    type: Number,
    deprecated: true,
    description: `@deprecated — use cursor instead. Capped at ${MAX_OFFSET}.`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_OFFSET)
  offset?: number;

  /**
   * Filter by source chain.
   */
  @ApiPropertyOptional({ type: String, description: "Filter by source chain" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  chain?: string;
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  INTENT_STATES,
  IntentState,
  SUPPORTED_CHAINS,
  SupportedChain,
} from "../intents.types";
import { LIST_MAX_LIMIT } from "../../config/limits.config";

export class ListIntentsDto {
  @ApiPropertyOptional({
    description: "Filter by intent state",
    enum: INTENT_STATES,
  })
  @IsOptional()
  @IsIn(INTENT_STATES)
  state?: IntentState;

  @ApiPropertyOptional({ description: "Filter by user address" })
  @IsOptional()
  @IsString()
  user?: string;

  @ApiPropertyOptional({
    description: "Filter by source chain",
    enum: SUPPORTED_CHAINS,
  })
  @IsOptional()
  @IsIn(SUPPORTED_CHAINS)
  chain?: SupportedChain;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: LIST_MAX_LIMIT,
    default: 20,
    description: `Number of results per page (max ${LIST_MAX_LIMIT})`,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(LIST_MAX_LIMIT)
  limit?: number;

  @ApiPropertyOptional({ description: "Cursor for the next page of intents" })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 0, default: 0, description: "Number of results to skip" })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * Core intent types for vortex-backend.
 *
 * These types are the source of truth for all modules.  The package-level
 * types in src/types/index.ts mirror a subset of these for SDK consumers.
 */

// ─── Chains ──────────────────────────────────────────────────────────────────

 * Single source of truth for every chain the protocol recognises.
 * `SupportedChain` is derived from this tuple so all three consumers
 * (intents.types.ts, create-intent.dto.ts, tokens.data.ts) stay in sync
 * automatically — see issue #128.
 */
export const SUPPORTED_CHAINS = [
  "stellar",
  "ethereum",
  "base",
  "polygon",
  "arbitrum",
  "optimism",
  "avalanche",
] as const;

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

// ─── Intent states ────────────────────────────────────────────────────────────

/**
 * The Stellar chain identifier, named for readability at call sites that would
 * otherwise repeat the literal.
 *
 * Distinct from the Soroban *network* ("testnet" / "mainnet" /
 * "futurenet"), which selects an RPC endpoint. Kill-switch scopes and intent
 * records are addressed by chain, not by network, so anything matching against
 * a chain must use this value.
 */
export const STELLAR_CHAIN = "stellar" satisfies SupportedChain;

/**
 * A single entry in the append-only audit log for an intent.
 * Every state transition — cancel, expire, accept, fill — appends one entry.
 * Once persistence lands (issue #36) this will be written to an `intent_audit_log`
 * table; for now it lives in-memory alongside the intent map.
 */
export interface IntentAuditEntry {
  /** ISO-8601 UTC timestamp of the transition. */
  timestamp: string;
  /** State the intent moved INTO. */
  toState: IntentState;
  /** Actor who triggered the transition: a user address, solver address, or "system". */
  actor: string;
  /** Human-readable explanation, e.g. "user cancelled", "deadline passed". */
  reason: string;
  /** Optional extra data (fill amount, tx hash, …). */
  metadata?: Record<string, unknown>;
}

/**
 * Single source of truth for every state an intent can be in.
 * `IntentState` is derived from this tuple so DTO validators (`@IsIn`),
 * Swagger `enum:` annotations, and type-checking all stay in sync
 * automatically — mirrors how `SUPPORTED_CHAINS` is defined above (issue #270).
 */
export const INTENT_STATES = [
  "open",
  "accepted",
  "filled",
  "cancelled",
  "expired",
  "slashed",
] as const;

export type IntentState = (typeof INTENT_STATES)[number];

// ─── Token types ──────────────────────────────────────────────────────────────

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chain: SupportedChain;
  logoURI?: string;
  priceUSD?: number | null;
  priceUSD?: number;
}

export interface StellarToken {
  contract: string;
  symbol: string;
  decimals: number;
  priceUSD?: number | null;
}

// ─── Source-verification ──────────────────────────────────────────────────────

export type VerificationStatus = "pending" | "verified" | "failed" | "grandfathered";

export interface SrcVerificationResult {
  status: VerificationStatus;
  checkedAt: number;
  blockNumber?: string;
  blockHash?: string;
  detail?: string;
  receivedAmount?: string;
}

// ─── Intent ──────────────────────────────────────────────────────────────────

/**
 * Canonical in-memory representation of a cross-chain swap intent.
 *
 * Bigint amounts (srcAmount, minDstAmount, fillAmount, quotedDstAmount, feeAmount)
 * are stored as decimal strings throughout — never coerced through `Number` so
 * precision is preserved for large ERC-20 amounts.
 *
 * Issue #410 adds `srcTokenId` / `dstTokenId` / `srcDecimals` / `dstDecimals`
 * which are populated by the create path when the token is in the registry.
 * They are intentionally optional so the expand/contract migration can land
 * without breaking the in-memory or dual-write adapters.
 */
  priceUSD?: number;
}

export interface Intent {
  intentId: string;
  user: string;
  srcChain: SupportedChain;
  srcToken: TokenInfo;
  srcAmount: string;
  dstToken: StellarToken;
  minDstAmount: string;
  quotedDstAmount?: string;
  acceptedDstAmount?: string;
  srcAmount: string; // bigint as string
  dstToken: StellarToken;
  minDstAmount: string;
  quotedDstAmount?: string; // best quote from solvers
  solver?: string;
  state: IntentState;
  createdAt: number;
  deadline: number;
  filledAt?: number;
  fillAmount?: string;
  feeAmount?: string;
  txHash?: string;
  slashedAt?: number;
  slashReason?: string;

  // Optimistic concurrency (#404)
  version: number;

  // Dutch auction (#429)
  auction?: Record<string, unknown>;

  // Source-deposit verification (#403)
  srcVerified: boolean;
  srcTxHash?: string;
  srcVerification?: SrcVerificationResult;

  // Governance params snapshot at creation
  paramsVersion?: string;

  // ── #410: FK columns (populated at create-time when token is in registry) ──
  srcTokenId?: string;
  dstTokenId?: string;
  /** Immutable snapshot of src token decimals at intent creation time. */
  srcDecimals?: number;
  /** Immutable snapshot of dst token decimals at intent creation time. */
  dstDecimals?: number;
}

export interface IntentAuditEntry {
  timestamp: string;
  toState: IntentState;
  actor: string;
  reason: string;
  metadata?: Record<string, unknown>;
  feeAmount?: string; // realized protocol fee in dst token base units
  txHash?: string; // fill tx on Stellar
  slashedAt?: number;
  slashReason?: string;
  /**
   * Snapshot of the governance-controlled protocol parameters that were active
   * when this intent was created.  Used to evaluate fee/window terms for
   * in-flight intents even after a governance update changes the live values.
   * Absent on intents created before issue #500 was deployed.
   */
  paramsVersion?: number;
}

export interface Quote {
  intentId: string;
  solver: string;
  dstAmount: string;
  fee: string; // protocol fee in dst token
  fillTime: number; // estimated seconds
  expiresAt: number;
}

export interface RouteStep {
  type: "bridge" | "swap" | "transfer";
  protocol: string;
  fromChain: string;
  toChain: string;
  fromToken: TokenInfo;
  toToken: TokenInfo;
  estimatedTime: number;
  estimatedGas: string;
}

export interface Route {
  steps: RouteStep[];
  totalTime: number; // seconds
  totalFeesUSD: number;
  priceImpact: number;
}

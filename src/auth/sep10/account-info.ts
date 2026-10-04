import { Horizon, WebAuth } from "@stellar/stellar-sdk";

/** Injection token for the {@link Sep10AccountInfoLoader} provider. */
export const SEP10_ACCOUNT_INFO_LOADER = "SEP10_ACCOUNT_INFO_LOADER";

/**
 * A signer of the SEP-10 client account (issue #442) — `{ key, weight, type }`
 * exactly as the SDK's `verifyChallengeTxThreshold` signer summary expects
 * (derived from that function's signature so the two can never drift).
 * Signers that are not address-strkey prefixed are ignored by the SDK.
 */
export type Sep10Signer = Parameters<typeof WebAuth.verifyChallengeTxThreshold>[4][number];

/** On-chain account facts the SEP-10 exchange needs (issue #442). */
export interface Sep10AccountInfo {
  /**
   * Weighted-signature threshold a challenge must meet. Implementations use
   * the account's medium threshold, floored at 1: an account whose thresholds
   * are all zero (a freshly created account) must still prove possession of a
   * signing key rather than passing an unsigned challenge.
   */
  threshold: number;
  signers: Sep10Signer[];
}

/**
 * Loads `thresholds` + `signers` for the client account that must verify a
 * SEP-10 challenge. Kept behind an interface so tests inject fixtures and
 * never touch the network (issue #442).
 */
export interface Sep10AccountInfoLoader {
  load(account: string): Promise<Sep10AccountInfo>;
}

/**
 * Horizon-backed loader: `GET /accounts/{id}` is the canonical source of an
 * account's signers and thresholds (issue #442).
 */
export class HorizonAccountInfoLoader implements Sep10AccountInfoLoader {
  constructor(private readonly horizonUrl: string) {}

  async load(account: string): Promise<Sep10AccountInfo> {
    const record = await new Horizon.Server(this.horizonUrl).loadAccount(account);
    // Horizon returns `{ low, medium, high }` weights; the SDK types this as
    // the XDR `AccountThresholds` shape, so narrow it structurally.
    const { medium } = record.thresholds as unknown as { low: string; medium: string; high: string };
    return {
      threshold: Math.max(1, Number(medium)),
      signers: record.signers,
    };
  }
}

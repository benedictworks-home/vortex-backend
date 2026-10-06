import { Keypair } from "@stellar/stellar-sdk";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { ed25519PublicKeyFor, loadEd25519PrivateKey } from "../../common/jwt";
import { logger } from "../../common/logger";

/** Injection token for {@link Sep10KeyMaterial}. */
export const SEP10_KEYS = "SEP10_KEYS";

/**
 * The key material the SEP-10 flow (issue #442) needs in one place:
 *
 * - `challenge` signs the server half of every challenge transaction
 *   (`STELLAR_SIGNER_SECRET_KEY`, ephemeral in dev when unset).
 * - `jwtPrivateKey` signs the short-lived session JWTs (`SEP10_JWT_SIGNING_KEY`,
 *   an Ed25519 key that must be distinct from the Soroban signer key;
 *   ephemeral in dev when unset).
 *
 * The material is resolved once per process so the issuing service and the
 * WebSocket guard verify with the *same* key even when only an ephemeral
 * (dev) key is configured. Production deployments must set
 * `SEP10_JWT_SIGNING_KEY`, otherwise tokens do not survive a restart or a
 * replica change — `env.validation.ts` enforces that.
 */
export interface Sep10KeyMaterial {
  /** Server keypair that signs SEP-10 challenge transactions. */
  readonly challenge: Keypair;
  /** Ed25519 private key that signs issued session JWTs. */
  readonly jwtPrivateKey: KeyObject;
  /** Public half of `jwtPrivateKey`, used to verify issued JWTs. */
  readonly jwtPublicKey: KeyObject;
  /** True when either key had to be generated for this process (dev only). */
  readonly ephemeral: boolean;
}

let cached: Sep10KeyMaterial | null = null;

/**
 * Resolves (and caches) the process-wide SEP-10 key material from the two
 * configured secrets. Throws when a non-empty value is not a usable key so a
 * production misconfiguration fails at boot rather than silently issuing
 * tokens nobody can verify.
 *
 * @param stellarSignerSecret - `STELLAR_SIGNER_SECRET_KEY`, or "" for an
 *   ephemeral challenge keypair (dev/test only).
 * @param jwtSigningKey - `SEP10_JWT_SIGNING_KEY` (Ed25519 PKCS#8 PEM or
 *   base64 DER), or "" for an ephemeral key (dev/test only).
 */
export function sep10Keys(stellarSignerSecret: string, jwtSigningKey: string): Sep10KeyMaterial {
  if (cached) return cached;

  let challenge: Keypair;
  const seed = stellarSignerSecret.trim();
  if (seed) {
    try {
      challenge = Keypair.fromSecret(seed);
    } catch {
      throw new Error("STELLAR_SIGNER_SECRET_KEY is not a valid Stellar secret seed");
    }
  } else {
    challenge = Keypair.random();
    logger.warn(
      "SEP-10: STELLAR_SIGNER_SECRET_KEY is empty — using an ephemeral challenge key; " +
        "challenges signed by this process will not verify after a restart",
    );
  }

  const provided = jwtSigningKey.trim();
  let jwtPrivateKey: KeyObject;
  let ephemeral = false;
  if (provided) {
    const loaded = loadEd25519PrivateKey(provided);
    if (!loaded) {
      throw new Error(
        "SEP10_JWT_SIGNING_KEY is not a usable Ed25519 PKCS#8 private key " +
          "(generate one with: openssl genpkey -algorithm ed25519)",
      );
    }
    jwtPrivateKey = loaded;
  } else {
    jwtPrivateKey = generateKeyPairSync("ed25519").privateKey;
    ephemeral = true;
    logger.warn(
      "SEP-10: SEP10_JWT_SIGNING_KEY is empty — using an ephemeral JWT key; " +
        "issued tokens will not verify after a restart or on another replica",
    );
  }

  cached = {
    challenge,
    jwtPrivateKey,
    jwtPublicKey: ed25519PublicKeyFor(jwtPrivateKey),
    ephemeral: ephemeral || seed === "",
  };
  return cached;
}

/** Clears the cached key material (test hook; production never calls this). */
export function resetSep10Keys(): void {
  cached = null;
}

/**
 * Resolves just the Ed25519 public key needed to *verify* issued session JWTs
 * (issue #442), from the same two config values the Sep10Module factory uses.
 *
 * Returns null when a non-empty signing key is unusable — verification then
 * falls back to HS256 only. The Sep10Module factory still fails boot in that
 * configuration, so this path only surfaces in tests and direct constructions.
 */
export function sep10JwtPublicKey(stellarSignerSecret: string, jwtSigningKey: string): KeyObject | null {
  try {
    return sep10Keys(stellarSignerSecret, jwtSigningKey).jwtPublicKey;
  } catch (error) {
    logger.warn(`SEP-10 JWT verification unavailable — ${(error as Error).message}`);
    return null;
  }
}

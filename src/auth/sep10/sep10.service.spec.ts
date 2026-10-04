/**
 * SEP-10 challenge authentication conformance and security tests (issue #442).
 *
 * Unit tests map no mock for `@stellar/stellar-sdk`, so these run against the
 * genuine challenge builder/verifier: challenge shape, threshold/multisig
 * verification, single-use nonces, expiry, and the EdDSA session JWTs.
 */
import { BadRequestException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { Keypair, Transaction, WebAuth } from "@stellar/stellar-sdk";
import { generateKeyPairSync, createPublicKey, type KeyObject } from "node:crypto";
import { NETWORK_PASSPHRASES, type AppConfig } from "../../config/configuration";
import { loadEd25519PrivateKey, signEddsaJwt, signHs256Jwt, verifyEddsaJwt } from "../../common/jwt";
import type { SolversService } from "../../solvers/solvers.service";
import type { Sep10AccountInfo, Sep10AccountInfoLoader } from "./account-info";
import { InMemorySep10NonceStore, type Sep10NonceStore } from "./nonce.store";
import { resetSep10Keys, sep10Keys, type Sep10KeyMaterial } from "./sep10-keys";
import {
  Sep10Service,
  SEP10_CHALLENGE_TIMEOUT_SECONDS,
  SEP10_JWT_TTL_SECONDS,
  type Sep10Role,
} from "./sep10.service";

const HOME = "vortex.example.com";
const PASSPHRASE = NETWORK_PASSPHRASES.testnet;

/** Server + client keys for the flow; JWT material is independent of them. */
const server = Keypair.random();
const client = Keypair.random();
const jwtMaterial = generateKeyPairSync("ed25519");
const keys: Sep10KeyMaterial = {
  challenge: server,
  jwtPrivateKey: jwtMaterial.privateKey,
  jwtPublicKey: createPublicKey(jwtMaterial.privateKey),
  ephemeral: false,
};

/** Registered solvers (role "solver") by address. */
const registered = new Map<string, { address: string; isActive: boolean }>();
const solvers = {
  get: async (address: string) => registered.get(address),
} as unknown as SolversService;

/** On-chain account fixtures by address; unknown accounts throw a 404. */
const accounts = new Map<string, Sep10AccountInfo>();
const loader: Sep10AccountInfoLoader = {
  load: async (address) => {
    const info = accounts.get(address);
    if (!info) {
      const error = new Error("Not Found") as Error & { response?: { status: number } };
      error.response = { status: 404 };
      throw error;
    }
    return info;
  },
};

function fakeConfig(overrides: Record<string, unknown> = {}): ConfigService<AppConfig, true> {
  const values: Record<string, unknown> = {
    sep10HomeDomain: HOME,
    sep10AdminAccounts: "",
    "stellar.network": "testnet",
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppConfig, true>;
}

interface ServiceOverrides {
  adminAccounts?: string;
  homeDomain?: string;
  nonces?: Sep10NonceStore;
  loader?: Sep10AccountInfoLoader;
  solvers?: unknown;
}

function makeService(overrides: ServiceOverrides = {}) {
  const nonces = overrides.nonces ?? new InMemorySep10NonceStore();
  const service = new Sep10Service(
    fakeConfig({
      sep10AdminAccounts: overrides.adminAccounts ?? "",
      sep10HomeDomain: overrides.homeDomain ?? HOME,
    }),
    nonces,
    (overrides.solvers ?? solvers) as SolversService,
    keys,
    overrides.loader ?? loader,
  );
  return { service, nonces };
}

/** Signs a challenge on the client side (one or more account signers). */
function signChallenge(challengeXdr: string, ...signers: Keypair[]): string {
  const tx = new Transaction(challengeXdr, PASSPHRASE);
  for (const signer of signers) tx.sign(signer);
  return tx.toEnvelope().toXDR("base64").toString();
}

/** Account fixture: the given key(s) as signers, weight summing to `threshold`. */
function multiSigner(threshold: number, ...signers: Keypair[]): Sep10AccountInfo {
  return {
    threshold,
    signers: signers.map((signer) => ({
      key: signer.publicKey(),
      weight: 1,
      type: "ed25519_public_key",
    })),
  };
}

async function expectRejected(promise: Promise<unknown>, match: RegExp): Promise<void> {
  await promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(BadRequestException);
      expect(String((error as Error).message)).toMatch(match);
    },
  );
}

beforeEach(() => {
  registered.clear();
  accounts.clear();
  accounts.set(client.publicKey(), multiSigner(1, client));
});

describe("Sep10Service.buildChallenge", () => {
  it("issues a SEP-10-conformant challenge bound to this server", async () => {
    const { service } = makeService();
    const challenge = await service.buildChallenge(client.publicKey());

    expect(challenge.network_passphrase).toBe(PASSPHRASE);
    const tx = new Transaction(challenge.transaction, PASSPHRASE);
    expect(tx.source).toBe(server.publicKey());
    expect(tx.sequence).toBe("0");
    const bounds = tx.timeBounds;
    expect(Number(bounds?.maxTime) - Number(bounds?.minTime)).toBe(SEP10_CHALLENGE_TIMEOUT_SECONDS);

    const [nonceOp, domainOp] = tx.operations;
    if (nonceOp?.type !== "manageData") throw new Error(`expected manageData, got ${nonceOp?.type}`);
    if (domainOp?.type !== "manageData") throw new Error(`expected manageData, got ${domainOp?.type}`);
    expect(nonceOp.name).toBe(`${HOME} auth`);
    expect(nonceOp.source).toBe(client.publicKey());
    expect(domainOp.name).toBe("web_auth_domain");
    expect(tx.operations).toHaveLength(2);
  });

  it("produces a challenge the SDK itself accepts (server sig, domains, nonce)", async () => {
    const { service } = makeService();
    const challenge = await service.buildChallenge(client.publicKey());
    const read = WebAuth.readChallengeTx(challenge.transaction, server.publicKey(), PASSPHRASE, HOME, HOME);
    expect(read.clientAccountID).toBe(client.publicKey());
    expect(read.matchedHomeDomain).toBe(HOME);
  });

  it("rejects non-G addresses", async () => {
    const { service } = makeService();
    await expectRejected(service.buildChallenge("not-a-stellar-address"), /G-address/);
  });
});

describe("Sep10Service.exchange", () => {
  it("issues a 15-minute EdDSA JWT with sub and role claims", async () => {
    const { service } = makeService();
    const challenge = await service.buildChallenge(client.publicKey());
    const result = await service.exchange(signChallenge(challenge.transaction, client));

    expect(result.token_type).toBe("Bearer");
    expect(result.expires_in).toBe(SEP10_JWT_TTL_SECONDS);

    const header = JSON.parse(Buffer.from(result.token.split(".")[0] ?? "", "base64url").toString("utf8"));
    expect(header.alg).toBe("EdDSA");

    const claims = verifyEddsaJwt(result.token, keys.jwtPublicKey);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe(client.publicKey());
    expect(claims?.role).toBe("user");
    expect(Number(claims?.exp) - Number(claims?.iat)).toBe(SEP10_JWT_TTL_SECONDS);
  });

  it("grants role=solver for registered solver accounts", async () => {
    registered.set(client.publicKey(), { address: client.publicKey(), isActive: true });
    const { service } = makeService();
    const challenge = await service.buildChallenge(client.publicKey());
    const result = await service.exchange(signChallenge(challenge.transaction, client));
    expect(verifyEddsaJwt(result.token, keys.jwtPublicKey)?.role).toBe("solver" satisfies Sep10Role);
  });

  it("grants role=admin for SEP10_ADMIN_ACCOUNTS entries (comma list)", async () => {
    const other = Keypair.random().publicKey();
    const { service } = makeService({ adminAccounts: `${other}, ${client.publicKey()}` });
    const challenge = await service.buildChallenge(client.publicKey());
    const result = await service.exchange(signChallenge(challenge.transaction, client));
    expect(verifyEddsaJwt(result.token, keys.jwtPublicKey)?.role).toBe("admin" satisfies Sep10Role);
  });

  it("accepts a multi-signature challenge once the threshold is met", async () => {
    const account = Keypair.random();
    const signerA = Keypair.random();
    const signerB = Keypair.random();
    accounts.set(account.publicKey(), multiSigner(2, signerA, signerB));
    const { service } = makeService();

    const challenge = await service.buildChallenge(account.publicKey());
    // Weight 1 < threshold 2 → rejected, and the nonce must NOT be burned by
    // the failed attempt (verification happens before consumption).
    await expectRejected(service.exchange(signChallenge(challenge.transaction, signerA)), /challenge rejected/);
    // Both signers → weight 2 meets the threshold.
    const result = await service.exchange(signChallenge(challenge.transaction, signerA, signerB));
    expect(verifyEddsaJwt(result.token, keys.jwtPublicKey)?.sub).toBe(account.publicKey());
  });

  it("rejects a challenge signed by an unknown key", async () => {
    const { service } = makeService();
    const challenge = await service.buildChallenge(client.publicKey());
    await expectRejected(
      service.exchange(signChallenge(challenge.transaction, Keypair.random())),
      /challenge rejected/,
    );
  });

  it("rejects a replayed challenge (single-use nonce)", async () => {
    const { service } = makeService();
    const challenge = await service.buildChallenge(client.publicKey());
    const signed = signChallenge(challenge.transaction, client);
    await service.exchange(signed);
    await expectRejected(service.exchange(signed), /nonce was not issued by this server/);
  });

  it("rejects a challenge whose nonce was never issued", async () => {
    const { service } = makeService();
    const foreign = WebAuth.buildChallengeTx(
      server,
      client.publicKey(),
      HOME,
      SEP10_CHALLENGE_TIMEOUT_SECONDS,
      PASSPHRASE,
      HOME,
    );
    await expectRejected(service.exchange(signChallenge(foreign, client)), /nonce was not issued by this server/);
  });

  it("rejects an expired challenge", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const { service } = makeService();
      const challenge = await service.buildChallenge(client.publicKey());
      const signed = signChallenge(challenge.transaction, client);
      // Past maxTime plus the SDK's 300s clock-drift grace.
      jest.setSystemTime(Date.now() + (SEP10_CHALLENGE_TIMEOUT_SECONDS + 350) * 1000);
      await expectRejected(service.exchange(signed), /challenge rejected/);
    } finally {
      jest.useRealTimers();
    }
  });

  it("rejects a challenge minted for a different home domain", async () => {
    const { service } = makeService();
    const foreign = WebAuth.buildChallengeTx(
      server,
      client.publicKey(),
      "evil.example",
      SEP10_CHALLENGE_TIMEOUT_SECONDS,
      PASSPHRASE,
      "evil.example",
    );
    await expectRejected(service.exchange(signChallenge(foreign, client)), /challenge rejected/);
  });

  it("rejects challenges for accounts that do not exist on the network", async () => {
    const ghost = Keypair.random();
    const { service } = makeService();
    const challenge = await service.buildChallenge(ghost.publicKey());
    await expectRejected(service.exchange(signChallenge(challenge.transaction, ghost)), /does not exist/);
  });
});

describe("verifyEddsaJwt", () => {
  const now = 1_760_000_000;
  const otherMaterial = generateKeyPairSync("ed25519");

  it("accepts a freshly signed token", () => {
    const token = signEddsaJwt({ sub: client.publicKey(), role: "user", iat: now, exp: now + 60 }, keys.jwtPrivateKey);
    expect(verifyEddsaJwt(token, keys.jwtPublicKey, now)).not.toBeNull();
  });

  it("rejects HS256 tokens (algorithm downgrade)", () => {
    const token = signHs256Jwt({ sub: client.publicKey(), exp: now + 60 }, "a-shared-secret");
    expect(verifyEddsaJwt(token, keys.jwtPublicKey, now)).toBeNull();
  });

  it("rejects expired tokens", () => {
    const token = signEddsaJwt({ sub: client.publicKey(), role: "user", exp: now - 1 }, keys.jwtPrivateKey);
    expect(verifyEddsaJwt(token, keys.jwtPublicKey, now)).toBeNull();
  });

  it("rejects tokens signed with another key", () => {
    const token = signEddsaJwt({ sub: client.publicKey(), role: "user", exp: now + 60 }, otherMaterial.privateKey);
    expect(verifyEddsaJwt(token, keys.jwtPublicKey, now)).toBeNull();
  });

  it("rejects tampered payloads", () => {
    const token = signEddsaJwt({ sub: client.publicKey(), role: "user", exp: now + 60 }, keys.jwtPrivateKey);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: client.publicKey(), role: "admin", exp: now + 60 })).toString(
      "base64url",
    );
    expect(verifyEddsaJwt(`${header}.${forged}.${signature}`, keys.jwtPublicKey, now)).toBeNull();
  });
});

describe("SEP-10 key material", () => {
  const material = generateKeyPairSync("ed25519");
  const pem = material.privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  afterEach(() => resetSep10Keys());

  it("loads PEM, literal-newline PEM, and bare base64 DER", () => {
    expect(loadEd25519PrivateKey(pem)).not.toBeNull();
    expect(loadEd25519PrivateKey(pem.replace(/\n/g, "\\n"))).not.toBeNull();
    const der = pem
      .replace("-----BEGIN PRIVATE KEY-----", "")
      .replace("-----END PRIVATE KEY-----", "")
      .replace(/\s+/g, "");
    const fromDer = loadEd25519PrivateKey(der);
    expect(fromDer).not.toBeNull();
    if (!fromDer) throw new Error("expected base64 DER to load");
    // Same key in all three encodings: identical public halves.
    const exported = (key: KeyObject) =>
      createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
    expect(exported(fromDer)).toBe(exported(material.privateKey));
  });

  it("returns null for empty or unusable input", () => {
    expect(loadEd25519PrivateKey("")).toBeNull();
    expect(loadEd25519PrivateKey("definitely-not-a-key")).toBeNull();
  });

  it("fails fast on an unusable configured signing key", () => {
    expect(() => sep10Keys(server.secret(), "not-a-valid-key!!!")).toThrow(/SEP10_JWT_SIGNING_KEY/);
  });

  it("generates ephemeral keys when nothing is configured (dev only)", () => {
    const first = sep10Keys("", "");
    expect(first.ephemeral).toBe(true);
    resetSep10Keys();
    const second = sep10Keys("", "");
    expect(second.ephemeral).toBe(true);
    const exportOne = first.jwtPublicKey.export({ type: "spki", format: "der" }).toString("base64");
    const exportTwo = second.jwtPublicKey.export({ type: "spki", format: "der" }).toString("base64");
    expect(exportOne).not.toBe(exportTwo);
  });
});

/**
 * SolverJwtGuard tests (issue #443/#442): Bearer extraction, EdDSA session
 * tokens issued by the SEP-10 flow, HS256 backward compatibility, and the
 * subject/path-address match.
 */
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-sdk";
import { generateKeyPairSync } from "node:crypto";
import type { AppConfig } from "../../config/configuration";
import { signEddsaJwt, signHs256Jwt } from "../../common/jwt";
import { resetSep10Keys } from "../sep10/sep10-keys";
import { SolverJwtGuard } from "./solver-jwt.guard";

const HS_SECRET = "hs256-secret-that-is-long-enough-for-tests";
const solver = Keypair.random();
const jwtMaterial = generateKeyPairSync("ed25519");
const jwtPem = jwtMaterial.privateKey.export({ type: "pkcs8", format: "pem" }) as string;

function fakeConfig(overrides: Record<string, unknown> = {}): ConfigService<AppConfig, true> {
  const values: Record<string, unknown> = {
    authJwtSecret: HS_SECRET,
    "stellar.signerSecretKey": "",
    sep10JwtSigningKey: "",
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppConfig, true>;
}

/** Builds an ExecutionContext whose getRequest always returns the same object. */
function makeContext(headers: Record<string, string | undefined>, address: string) {
  const request: { headers: Record<string, string | undefined>; params: { address: string }; solverAddress?: string } =
    { headers, params: { address } };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

function guardWith(overrides: Record<string, unknown>): SolverJwtGuard {
  return new SolverJwtGuard(fakeConfig(overrides));
}

beforeEach(() => resetSep10Keys());

describe("SolverJwtGuard (SEP-10 EdDSA tokens, issue #442)", () => {
  it("accepts a valid EdDSA token and attaches the solver address", () => {
    const guard = guardWith({ sep10JwtSigningKey: jwtPem });
    const token = signEddsaJwt(
      { sub: solver.publicKey(), role: "solver", exp: Math.floor(Date.now() / 1000) + 600 },
      jwtMaterial.privateKey,
    );
    const { context, request } = makeContext({ authorization: `Bearer ${token}` }, solver.publicKey());
    expect(guard.canActivate(context)).toBe(true);
    expect(request.solverAddress).toBe(solver.publicKey());
  });

  it("accepts EdDSA tokens when the legacy HS256 secret is unset", () => {
    const guard = guardWith({ sep10JwtSigningKey: jwtPem, authJwtSecret: "" });
    const token = signEddsaJwt(
      { sub: solver.publicKey(), role: "solver", exp: Math.floor(Date.now() / 1000) + 600 },
      jwtMaterial.privateKey,
    );
    const { context } = makeContext({ authorization: `Bearer ${token}` }, solver.publicKey());
    expect(guard.canActivate(context)).toBe(true);
  });

  it("rejects an expired EdDSA token", () => {
    const guard = guardWith({ sep10JwtSigningKey: jwtPem });
    const token = signEddsaJwt({ sub: solver.publicKey(), role: "solver", exp: 1 }, jwtMaterial.privateKey);
    const { context } = makeContext({ authorization: `Bearer ${token}` }, solver.publicKey());
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("rejects an EdDSA token signed with a foreign key", () => {
    const guard = guardWith({ sep10JwtSigningKey: jwtPem });
    const foreign = generateKeyPairSync("ed25519");
    const token = signEddsaJwt(
      { sub: solver.publicKey(), role: "solver", exp: Math.floor(Date.now() / 1000) + 600 },
      foreign.privateKey,
    );
    const { context } = makeContext({ authorization: `Bearer ${token}` }, solver.publicKey());
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});

describe("SolverJwtGuard (legacy HS256 fallback)", () => {
  it("still accepts HS256 tokens signed with AUTH_JWT_SECRET", () => {
    const guard = guardWith({});
    const token = signHs256Jwt({ sub: solver.publicKey(), exp: Math.floor(Date.now() / 1000) + 600 }, HS_SECRET);
    const { context, request } = makeContext({ authorization: `Bearer ${token}` }, solver.publicKey());
    expect(guard.canActivate(context)).toBe(true);
    expect(request.solverAddress).toBe(solver.publicKey());
  });

  it("rejects HS256 tokens signed with the wrong secret", () => {
    const guard = guardWith({});
    const token = signHs256Jwt({ sub: solver.publicKey(), exp: Math.floor(Date.now() / 1000) + 600 }, "wrong-secret");
    const { context } = makeContext({ authorization: `Bearer ${token}` }, solver.publicKey());
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});

describe("SolverJwtGuard (token extraction and subject match)", () => {
  it("rejects requests without a Bearer token", () => {
    const guard = guardWith({});
    const { context } = makeContext({}, solver.publicKey());
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("rejects garbage tokens", () => {
    const guard = guardWith({});
    const { context } = makeContext({ authorization: "Bearer not.a.jwt" }, solver.publicKey());
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("rejects tokens whose sub does not match the requested address", () => {
    const guard = guardWith({});
    const other = Keypair.random();
    const token = signHs256Jwt({ sub: other.publicKey(), exp: Math.floor(Date.now() / 1000) + 600 }, HS_SECRET);
    const { context } = makeContext({ authorization: `Bearer ${token}` }, solver.publicKey());
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});

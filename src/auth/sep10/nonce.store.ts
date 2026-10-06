import Redis from "ioredis";

/** Injection token for {@link Sep10NonceStore}. */
export const SEP10_NONCE_STORE = "SEP10_NONCE_STORE";

/**
 * Single-use store for SEP-10 challenge nonces (issue #442).
 *
 * The 48-byte nonce inside a challenge's `manageData` operation makes a
 * challenge unique; this store makes it *single-use*. `remember` is called
 * when the challenge is issued and `consume` atomically claims it when the
 * signed challenge is exchanged, so a captured challenge can never be
 * replayed for a second token.
 */
export interface Sep10NonceStore {
  /** Records a freshly issued nonce, expiring it after `ttlSeconds`. */
  remember(nonce: string, ttlSeconds: number): Promise<void>;
  /**
   * Atomically claims `nonce`. Returns true only for the first consumer;
   * false when the nonce was never issued or was already used.
   */
  consume(nonce: string): Promise<boolean>;
}

/**
 * Process-local nonce store for dev/test and single-replica deployments
 * without Redis. Expired entries are pruned opportunistically on writes.
 */
export class InMemorySep10NonceStore implements Sep10NonceStore {
  private readonly nonces = new Map<string, number>();

  async remember(nonce: string, ttlSeconds: number): Promise<void> {
    const now = Date.now();
    this.prune(now);
    this.nonces.set(nonce, now + ttlSeconds * 1000);
  }

  async consume(nonce: string): Promise<boolean> {
    const expiresAt = this.nonces.get(nonce);
    this.nonces.delete(nonce);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  private prune(nowMs: number): void {
    for (const [key, expiresAt] of this.nonces) {
      if (expiresAt <= nowMs) this.nonces.delete(key);
    }
  }
}

/**
 * Redis-backed nonce store shared by every replica (issue #442).
 *
 * Consumption runs a tiny Lua script so GET + DEL is a single atomic step —
 * two replicas exchanging the same challenge concurrently can only ever
 * succeed once. Keys carry an expiry so expired nonces cost nothing.
 */
export class RedisSep10NonceStore implements Sep10NonceStore {
  /** GET the nonce and delete it in one script; 1 when it existed, 0 otherwise. */
  private static readonly CONSUME_SCRIPT =
    'local v = redis.call("GET", KEYS[1]) if v then redis.call("DEL", KEYS[1]) end return (v and 1) or 0';

  constructor(private readonly redis: Redis) {}

  async remember(nonce: string, ttlSeconds: number): Promise<void> {
    // setex overwrites are harmless: nonces are 48 random bytes per challenge
    // and each buildChallenge issues a fresh one.
    await this.redis.setex(this.key(nonce), ttlSeconds, "1");
  }

  async consume(nonce: string): Promise<boolean> {
    const result: unknown = await this.redis.eval(RedisSep10NonceStore.CONSUME_SCRIPT, 1, this.key(nonce));
    return Number(result) === 1;
  }

  private key(nonce: string): string {
    return `sep10:nonce:${nonce}`;
  }
}

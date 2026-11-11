/**
 * Where solved challenges are recorded, so each one is accepted exactly once.
 *
 * Without this, a correctly answered (token, answer) pair could be replayed for
 * the token's whole lifetime: one human solves it, and a relay reuses the pair
 * as often as it likes until expiry.
 */
export interface NonceStore {
  /**
   * Marks `nonce` as spent. Resolves true the first time, false on any later
   * call for the same nonce. Must be atomic: when two calls race, exactly one
   * may win. The record may be forgotten after `ttlSeconds`, by which time the
   * challenge it belongs to has expired anyway.
   */
  consume(nonce: string, ttlSeconds: number): Promise<boolean>;
}

/**
 * In-process store, for tests and local development.
 *
 * ⚠️ Not replay-safe on Lambda: every concurrent execution environment has its
 * own memory, so a replay that lands on a different container is accepted. Use
 * a shared store such as `dynamoNonceStore` (from `lambda-captcha/dynamodb`) in
 * production.
 */
export function memoryNonceStore(): NonceStore {
  const spent = new Map<string, number>();
  return {
    async consume(nonce, ttlSeconds) {
      const now = Date.now();
      // Lazy sweep, so the map stays bounded by the number of live challenges.
      for (const [n, expires] of spent) if (expires <= now) spent.delete(n);
      if (spent.has(nonce)) return false;
      spent.set(nonce, now + ttlSeconds * 1000);
      return true;
    },
  };
}

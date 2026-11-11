import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stateless signed tokens: `base64url(JSON payload).base64url(HMAC-SHA256)`,
 * with an `exp` (Unix seconds) the reader enforces.
 */

export function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * A purpose-specific key derived from the caller's secret.
 *
 * Every token this package signs uses a key derived for that one purpose, so
 * the caller can hand over the same secret it signs its own cookies with: a
 * challenge token can never verify as a pass, and neither can ever verify as
 * one of the app's own tokens, or the reverse.
 */
export function subkey(secret: string, purpose: string): Buffer {
  return createHmac('sha256', secret).update(`lambda-captcha/${purpose}`).digest();
}

export function sign(payload: Record<string, unknown>, ttlSeconds: number, key: Buffer): string {
  const body = b64url(Buffer.from(JSON.stringify({ ...payload, exp: nowSeconds() + ttlSeconds })));
  return `${body}.${b64url(createHmac('sha256', key).update(body).digest())}`;
}

/**
 * Verifies the signature and decodes the payload, reporting expiry separately
 * so a short-lived token can tell an expired-but-genuine one from a forged one.
 */
export function read<T extends object>(
  token: string | null | undefined,
  key: Buffer,
): { payload: T; expired: boolean } | undefined {
  if (!token) return undefined;
  const dot = token.indexOf('.');
  if (dot < 0) return undefined;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(b64url(createHmac('sha256', key).update(body).digest()));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64').toString()) as T & { exp?: unknown };
    if (typeof payload !== 'object' || payload === null) return undefined;
    return { payload, expired: typeof payload.exp !== 'number' || payload.exp < nowSeconds() };
  } catch {
    return undefined;
  }
}

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HEIGHT, imageWidth, renderPng } from './image';
import { renderWav } from './audio';
import type { NonceStore } from './nonce';
import { b64url, read, sign, subkey } from './token';

export interface CaptchaOptions {
  /**
   * Signs challenge tokens and derives their answers. Use at least 32 random
   * bytes and keep it server-side. It may be the same secret the app signs its
   * own cookies with: this package only ever uses keys derived from it.
   */
  secret: string;
  /** Records solved challenges so each is accepted once (see NonceStore). */
  nonces: NonceStore;
  /** Digits per challenge, 4–8. Default 5. */
  digits?: number;
  /** How long a challenge can be answered, in seconds. Default 180. */
  ttlSeconds?: number;
}

/** One rendered challenge. Issue a fresh one per page render; never cache it. */
export interface Challenge {
  /** Signed token committing to the answer. Goes in a hidden form field. */
  token: string;
  /** The distorted digits, as a `data:image/png` URI. */
  image: string;
  width: number;
  height: number;
  digits: number;
}

/**
 * Outcome of checking an answer. Everything except `ok` should re-render the
 * form with a fresh challenge; `expired` and `used` deserve their own message,
 * because the person may well have typed the right digits.
 */
export type VerifyStatus = 'ok' | 'wrong' | 'expired' | 'used' | 'invalid';

export interface Captcha {
  readonly digits: number;
  readonly ttlSeconds: number;
  /** A new challenge: a fresh random seed, its image, and its token. */
  issue(): Challenge;
  /**
   * Checks a submitted answer against a token, and on success burns the
   * token's nonce so the same pair can't be accepted twice.
   */
  verify(token: string | null | undefined, answer: string | null | undefined): Promise<VerifyStatus>;
  /**
   * The same challenge, spoken, as a WAV file — the accessible alternative to
   * the image. Undefined for an expired or forged token, so it can't be used to
   * read out answers to tokens nobody was issued.
   */
  audio(token: string | null | undefined): Buffer | undefined;
}

const DEFAULT_DIGITS = 5;
const DEFAULT_TTL_SECONDS = 3 * 60;

/** Applies defaults and range checks. Shared with the gate, which checks early. */
export function captchaSettings(options: Pick<CaptchaOptions, 'digits' | 'ttlSeconds'>): {
  digits: number;
  ttlSeconds: number;
} {
  const digits = options.digits ?? DEFAULT_DIGITS;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(digits) || digits < 4 || digits > 8) {
    throw new RangeError(`digits must be an integer from 4 to 8 (got ${digits})`);
  }
  if (!(ttlSeconds > 0)) throw new RangeError(`ttlSeconds must be positive (got ${ttlSeconds})`);
  return { digits, ttlSeconds };
}

export function createCaptcha(options: CaptchaOptions): Captcha {
  const { digits, ttlSeconds } = captchaSettings(options);
  if (!options.secret) throw new TypeError('secret is required');

  const keys = keysFor(options.secret);
  const { nonces } = options;

  return {
    digits,
    ttlSeconds,

    issue() {
      // The seed is public. Expanding it to digits needs the secret.
      const seed = b64url(randomBytes(12));
      const answer = digitsFor(seed, keys.digits, digits);
      return {
        token: sign({ s: seed }, ttlSeconds, keys.token),
        image: `data:image/png;base64,${renderPng(answer).toString('base64')}`,
        width: imageWidth(digits),
        height: HEIGHT,
        digits,
      };
    },

    async verify(token, answer) {
      const r = read<{ s?: unknown }>(token, keys.token);
      if (!r || typeof r.payload.s !== 'string') return 'invalid';
      const seed = r.payload.s;
      const expected = Buffer.from(digitsFor(seed, keys.digits, digits));
      const submitted = Buffer.from((answer ?? '').replace(/\s+/g, ''));
      if (submitted.length !== expected.length || !timingSafeEqual(submitted, expected)) return 'wrong';
      // Checked after the comparison, so a right answer that arrived late is
      // reported as expired rather than as wrong.
      if (r.expired) return 'expired';
      // The seed doubles as the nonce: random, and unique to this challenge. A
      // wrong guess never reaches this point, so a typo doesn't spend it.
      return (await nonces.consume(seed, ttlSeconds)) ? 'ok' : 'used';
    },

    audio(token) {
      const answer = answerFor(token, keys, digits);
      return answer === undefined ? undefined : renderWav(answer);
    },
  };
}

interface Keys {
  token: Buffer;
  digits: Buffer;
}

function keysFor(secret: string): Keys {
  return { token: subkey(secret, 'challenge-token'), digits: subkey(secret, 'challenge-digits') };
}

/**
 * The digits a live token commits to. Not exported from the package: this is
 * the answer, and the only thing that should ever do with it is render it.
 * Tests reach it through `answerForSecret`.
 */
function answerFor(token: string | null | undefined, keys: Keys, digits: number): string | undefined {
  const r = read<{ s?: unknown }>(token, keys.token);
  if (!r || r.expired || typeof r.payload.s !== 'string') return undefined;
  return digitsFor(r.payload.s, keys.digits, digits);
}

/** Test hook: the answer to a token, given the secret. Not part of the public API. */
export function answerForSecret(token: string, secret: string, digits = DEFAULT_DIGITS): string | undefined {
  return answerFor(token, keysFor(secret), digits);
}

/**
 * Derives the digits from a public seed and a secret key.
 *
 * The token carries the seed rather than a hash of the answer, which is what
 * lets a second route (the audio alternative) regenerate the *same* digits from
 * the same token without any shared state.
 */
function digitsFor(seed: string, key: Buffer, count: number): string {
  let out = '';
  for (let block = 0; out.length < count; block++) {
    const h = createHmac('sha256', key).update(`${seed}:${block}`).digest();
    for (const b of h) {
      if (out.length >= count) break;
      // Rejection sampling: 250 is the largest multiple of 10 below 256, so
      // taking every byte mod 10 would over-represent the digits 0-5.
      if (b < 250) out += String(b % 10);
    }
  }
  return out;
}

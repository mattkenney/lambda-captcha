import { captchaSettings, createCaptcha, type Captcha, type VerifyStatus } from './challenge';
import { ANSWER_FIELD, TOKEN_FIELD } from './fields';
import type { NonceStore } from './nonce';
import { CSS_VERSION, PAGE_CSS, forwardPage, gatePage, type PageText } from './page';
import { read, sign, subkey } from './token';

/**
 * The parts of a Lambda event the gate reads: payload format 2.0, as sent by
 * Lambda Function URLs and API Gateway HTTP APIs. `APIGatewayProxyEventV2` from
 * `@types/aws-lambda` satisfies it as is.
 */
export interface GateEvent {
  rawPath: string;
  rawQueryString?: string;
  cookies?: string[];
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

/** A payload-2.0 response, assignable to `APIGatewayProxyStructuredResultV2`. */
export interface GateResponse {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded?: boolean;
}

export interface GateOptions {
  /**
   * Signs challenges and passes. A string, or a function returning one (for a
   * secret fetched from Secrets Manager at cold start). A function is called
   * once per container and its result kept, except after a rejection, which is
   * retried on the next request.
   */
  secret: string | (() => string | Promise<string>);
  /** Records solved challenges so each is accepted once (see NonceStore). */
  nonces: NonceStore;
  /** How long one solved challenge grants access, in seconds. Default 12 hours. */
  passTtlSeconds?: number;
  /** Name of the pass cookie. Default `__Host-captcha_pass`. */
  cookieName?: string;
  /**
   * Path prefix for the gate's own routes (verify, the audio and the
   * stylesheet). Default `/_captcha`. Behind an API Gateway stage other than
   * `$default`, include the stage: `/prod/_captcha`.
   */
  prefix?: string;
  /**
   * How the challenge form is submitted. Default `post`, which keeps answers
   * out of URLs, logs and browser history.
   *
   * Use `get` when CloudFront reaches a Function URL through an origin access
   * control (OAC). Lambda then requires every POST to carry a SHA-256 hash of
   * its body (`x-amz-content-sha256`), which CloudFront doesn't add and an
   * HTML form can't send, so a POST fails with "The request signature we
   * calculated does not match the signature you provided". A GET carries the
   * answer in the URL instead, which is harmless: a challenge is single-use and
   * expires in minutes.
   */
  verifyMethod?: 'post' | 'get';
  /**
   * Requests the gate should let through without a pass: health checks,
   * webhooks, `/robots.txt`. Default: none.
   */
  allow?: (request: { method: string; path: string }) => boolean;
  /** Digits per challenge, 4–8. Default 5. */
  digits?: number;
  /** How long a challenge can be answered, in seconds. Default 180. */
  challengeTtlSeconds?: number;
  /** Heading and `<title>` of the challenge page. */
  title?: string;
  /** The sentence under the heading. */
  intro?: string;
  /** `lang` of the challenge page. Default `en`. The page text is English unless you replace it. */
  lang?: string;
}

export interface Gate {
  /**
   * Resolves undefined when the request may proceed to the app. Otherwise
   * resolves the response to send instead: the challenge page, or one of the
   * gate's own routes.
   */
  handle(event: GateEvent): Promise<GateResponse | undefined>;
}

const DEFAULT_PASS_TTL_SECONDS = 12 * 60 * 60;
/** The form is a token, a few digits and a path. Anything bigger isn't ours. */
const MAX_BODY_BYTES = 16 * 1024;
const MAX_NEXT_LENGTH = 2048;

/**
 * Sent on every page the gate renders. A CDN response-headers policy that
 * overrides these must still allow `img-src data:`, `media-src 'self'` and
 * `style-src 'self'`.
 */
const PAGE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; img-src data:; media-src 'self'; style-src 'self'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
};

const MESSAGES: Record<Exclude<VerifyStatus, 'ok'>, string> = {
  wrong: "Those digits didn't match. Please try this one.",
  invalid: "Those digits didn't match. Please try this one.",
  expired: 'That image expired. Here is a new one.',
  used: 'That image was already used. Here is a new one.',
};

/**
 * A CAPTCHA in front of an entire Lambda web app: until a visitor solves a
 * challenge, every request gets the challenge page instead of the app. Solving
 * it sets a signed, HttpOnly pass cookie, valid for `passTtlSeconds`, and sends
 * the visitor on to the page they first asked for.
 *
 * Use `withCaptchaGate` to wrap a handler. Use `createGate(...).handle` inside
 * your own handler when something must run first, such as an origin check.
 */
export function createGate(options: GateOptions): Gate {
  const { digits, ttlSeconds: challengeTtlSeconds } = captchaSettings({
    digits: options.digits,
    ttlSeconds: options.challengeTtlSeconds,
  });
  const passTtlSeconds = options.passTtlSeconds ?? DEFAULT_PASS_TTL_SECONDS;
  if (!(passTtlSeconds > 0)) throw new RangeError(`passTtlSeconds must be positive (got ${passTtlSeconds})`);
  const prefix = options.prefix ?? '/_captcha';
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(prefix)) {
    throw new RangeError(`prefix must be a path like "/_captcha" with no trailing slash (got "${prefix}")`);
  }
  const cookieName = options.cookieName ?? '__Host-captcha_pass';
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookieName)) {
    throw new RangeError(`cookieName is not a valid cookie name (got "${cookieName}")`);
  }
  const verifyMethod = options.verifyMethod ?? 'post';
  if (verifyMethod !== 'post' && verifyMethod !== 'get') {
    throw new RangeError(`verifyMethod must be "post" or "get" (got "${String(verifyMethod)}")`);
  }
  const text: PageText = {
    title: options.title ?? 'Quick check',
    intro: options.intro ?? 'Before you continue, please type the digits below. It keeps automated traffic out.',
    lang: options.lang ?? 'en',
  };

  let ready: Promise<{ captcha: Captcha; passKey: Buffer }> | undefined;
  const setup = () =>
    (ready ??= (async () => {
      const secret = typeof options.secret === 'function' ? await options.secret() : options.secret;
      const captcha = createCaptcha({ secret, nonces: options.nonces, digits, ttlSeconds: challengeTtlSeconds });
      return { captcha, passKey: subkey(secret, 'pass') };
    })().catch((err: unknown) => {
      ready = undefined;
      throw err;
    }));

  const page = async (status: number, next: string, error?: string): Promise<GateResponse> => {
    const { captcha } = await setup();
    return {
      statusCode: status,
      headers: { ...PAGE_HEADERS },
      body: gatePage(captcha.issue(), { ...text, prefix, next, error, method: verifyMethod }),
    };
  };

  async function verify(event: GateEvent, form: URLSearchParams): Promise<GateResponse> {
    const next = safeNext(form.get('next'));
    // Already through: a resubmitted form, or (with GET) the back button
    // returning to a verify URL whose challenge is now spent. Carry on rather
    // than reporting that spent challenge as "already used".
    if (await hasPass(event)) return redirect(next);

    const { captcha, passKey } = await setup();
    const status = await captcha.verify(form.get(TOKEN_FIELD), form.get(ANSWER_FIELD));
    if (status !== 'ok') return page(400, next, MESSAGES[status]);

    // A "Loading" page that forwards itself, rather than a redirect, so the
    // visitor sees at once that the answer was accepted however slow the app
    // is (see forwardPage).
    const pass = sign({ p: 1 }, passTtlSeconds, passKey);
    return {
      statusCode: 200,
      headers: { ...PAGE_HEADERS },
      cookies: [`${cookieName}=${pass}; Path=/; Max-Age=${passTtlSeconds}; HttpOnly; Secure; SameSite=Lax`],
      body: forwardPage({ ...text, prefix, next }),
    };
  }

  async function audio(event: GateEvent): Promise<GateResponse> {
    const { captcha } = await setup();
    const wav = captcha.audio(new URLSearchParams(event.rawQueryString ?? '').get(TOKEN_FIELD));
    if (!wav) return { statusCode: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Not found' };
    // Binary bodies must go back base64-encoded, or the Function URL mangles them.
    return {
      statusCode: 200,
      headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' },
      body: wav.toString('base64'),
      isBase64Encoded: true,
    };
  }

  async function hasPass(event: GateEvent): Promise<boolean> {
    const value = cookie(event, cookieName);
    if (!value) return false;
    const { passKey } = await setup();
    const r = read<{ p?: unknown }>(value, passKey);
    return !!r && !r.expired && r.payload.p === 1;
  }

  return {
    async handle(event) {
      const method = event.requestContext.http.method.toUpperCase();
      const path = event.rawPath || '/';
      const reading = method === 'GET' || method === 'HEAD';

      // The gate's own routes, reachable with or without a pass.
      if (path.startsWith(`${prefix}/`)) {
        const route = path.slice(prefix.length);
        if (route === '/verify') {
          if (verifyMethod === 'post' && method === 'POST') return verify(event, parseForm(event));
          if (verifyMethod === 'get' && method === 'GET') {
            return verify(event, new URLSearchParams(event.rawQueryString ?? ''));
          }
          return redirect('/');
        }
        if (route === '/audio.wav' && reading) return audio(event);
        if (route === '/style.css' && reading) {
          return {
            statusCode: 200,
            headers: {
              'content-type': 'text/css; charset=utf-8',
              // Versioned by URL (?v=CSS_VERSION), so safe to keep for good.
              'cache-control': 'public, max-age=31536000, immutable',
              etag: `"${CSS_VERSION}"`,
            },
            body: PAGE_CSS,
          };
        }
        return { statusCode: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Not found' };
      }

      if (options.allow?.({ method, path })) return undefined;
      if (await hasPass(event)) return undefined;

      // Send the visitor back where they were going once they've solved it. Only
      // for a GET: a POST body can't be carried through the challenge, and a
      // GET to a POST-only route would just be an error page.
      const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
      return page(403, reading ? safeNext(path + query) : '/');
    },
  };
}

/**
 * Wraps a Lambda handler so that every request passes the gate first.
 *
 * ```ts
 * export const handler = withCaptchaGate(app, { secret, nonces });
 * ```
 *
 * The app's responses come back through `markPrivate`, so a CDN can't cache
 * one visitor's page and serve it to someone who hasn't solved a challenge.
 */
export function withCaptchaGate<E extends GateEvent, C, R>(
  handler: (event: E, context: C) => Promise<R>,
  options: GateOptions,
): (event: E, context: C) => Promise<R | GateResponse> {
  const gate = createGate(options);
  return async (event, context) => (await gate.handle(event)) ?? markPrivate(await handler(event, context));
}

/**
 * Makes a response that got past the gate uncacheable by shared caches: adds
 * `private` to its `Cache-Control` and drops `public` and `s-maxage`, keeping
 * whatever it said about the visitor's own browser cache (`max-age` and so on).
 *
 * Without this, an app page sent with `Cache-Control: max-age=300` is cached by
 * CloudFront, keyed without the pass cookie, and served for the next five
 * minutes to anyone who asks, challenged or not. `withCaptchaGate` applies it
 * for you. Call it yourself when using `createGate(...).handle`.
 *
 * Anything that isn't a structured response (`{ statusCode, ... }`) is
 * returned as is, and so is a response that already says `no-store`.
 */
export function markPrivate<R>(response: R): R {
  if (typeof response !== 'object' || response === null || !('statusCode' in response)) return response;
  const headers = { ...((response as { headers?: Record<string, unknown> }).headers ?? {}) };
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'cache-control');
  const directives = key === undefined ? [] : String(headers[key]).split(',').map((d) => d.trim()).filter(Boolean);
  const name = (d: string) => d.split('=')[0].trim().toLowerCase();
  if (directives.some((d) => name(d) === 'no-store')) return response;

  const kept = directives.filter((d) => !['public', 'private', 's-maxage', 'proxy-revalidate'].includes(name(d)));
  // Keep the app's own spelling of the header name, so it isn't sent twice.
  headers[key ?? 'cache-control'] = ['private', ...kept].join(', ');
  return { ...response, headers };
}

function redirect(location: string): GateResponse {
  return { statusCode: 303, headers: { location, 'cache-control': 'no-store' }, body: '' };
}

/**
 * Where to send the visitor after a solve: a same-origin path, or `/`.
 *
 * `next` is attacker-controlled (it is a form field, and the original request
 * path can itself be `//evil.example`), so this is the open-redirect check.
 * Browsers read `//host` and `/\host` as other origins and strip tabs and
 * newlines before parsing, so any backslash or control character is refused
 * outright rather than reasoned about.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || next.length > MAX_NEXT_LENGTH) return '/';
  if (next[0] !== '/' || next[1] === '/' || /[\\\u0000-\u001f\u007f]/.test(next)) return '/';
  try {
    const base = 'https://gate.invalid';
    return new URL(next, base).origin === base ? next : '/';
  } catch {
    return '/';
  }
}

function parseForm(event: GateEvent): URLSearchParams {
  let body = event.body ?? '';
  if (event.isBase64Encoded && body) body = Buffer.from(body, 'base64').toString('utf8');
  return Buffer.byteLength(body) > MAX_BODY_BYTES ? new URLSearchParams() : new URLSearchParams(body);
}

/** Payload 2.0 splits cookies into `event.cookies`; fall back to the raw header. */
function cookie(event: GateEvent, name: string): string | undefined {
  let list = event.cookies;
  if (!list) {
    const header = Object.entries(event.headers ?? {}).find(([k]) => k.toLowerCase() === 'cookie')?.[1];
    list = header ? header.split(';') : [];
  }
  for (const c of list) {
    const eq = c.indexOf('=');
    if (eq > 0 && c.slice(0, eq).trim() === name) return c.slice(eq + 1).trim();
  }
  return undefined;
}

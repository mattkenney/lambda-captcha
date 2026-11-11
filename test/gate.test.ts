import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createGate, memoryNonceStore, withCaptchaGate, type GateEvent, type GateResponse } from '../src/index';
import { answerForSecret } from '../src/challenge';
import { markPrivate, safeNext } from '../src/gate';

const secret = 'gate-secret-0123456789abcdef0123456789abcdef';

function event(
  method: string,
  pathAndQuery: string,
  init: { cookies?: string[]; form?: Record<string, string>; base64?: boolean; headers?: Record<string, string> } = {},
): GateEvent {
  const [rawPath, rawQueryString = ''] = pathAndQuery.split('?');
  let body = init.form ? new URLSearchParams(init.form).toString() : undefined;
  if (body && init.base64) body = Buffer.from(body).toString('base64');
  return {
    rawPath,
    rawQueryString,
    cookies: init.cookies,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...init.headers },
    body,
    isBase64Encoded: !!init.base64,
    requestContext: { http: { method } },
  };
}

const app = async (e: GateEvent) => ({ statusCode: 200, headers: {}, body: `app:${e.rawPath}` });

/** Decodes an attribute value the way a browser does. */
const fromHtml = (v: string) =>
  v.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Pulls the challenge's form fields back out of a rendered gate page. */
function formOf(res: GateResponse | { statusCode: number; body: string }): { token: string; next: string } {
  const token = /name="ct" value="([^"]+)"/.exec(res.body)?.[1];
  const next = /name="next" value="([^"]*)"/.exec(res.body)?.[1];
  assert.ok(token && next !== undefined, 'gate page carries a token and a next field');
  return { token, next: fromHtml(next) };
}

/**
 * Where a solved challenge's "Loading" page sends the visitor: its meta refresh
 * and its fallback link must agree, and both must be the same-origin target.
 */
function forwardTo(res: GateResponse): string {
  assert.equal(res.statusCode, 200);
  const refresh = /<meta http-equiv="refresh" content="0; url=&#39;([^"]*)&#39;">/.exec(res.body)?.[1];
  const link = /<a href="([^"]*)">Continue<\/a>/.exec(res.body)?.[1];
  assert.ok(refresh !== undefined && link !== undefined, 'forward page has a refresh and a link');
  assert.equal(fromHtml(refresh).replace(/%27/g, "'"), fromHtml(link));
  return fromHtml(link);
}

async function solve(handler: ReturnType<typeof withCaptchaGate<GateEvent, unknown, unknown>>, path = '/') {
  const page = (await handler(event('GET', path), {})) as GateResponse;
  const { token, next } = formOf(page);
  return (await handler(
    event('POST', '/_captcha/verify', { form: { ct: token, captcha: answerForSecret(token, secret)!, next } }),
    {},
  )) as GateResponse;
}

test('an unpassed request gets the challenge page, not the app', async () => {
  const handler = withCaptchaGate(app, { secret, nonces: memoryNonceStore() });
  const res = (await handler(event('GET', '/deep/page?q=1&r=2'), {})) as GateResponse;
  assert.equal(res.statusCode, 403);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.headers['content-security-policy'], /img-src data:/);
  assert.match(res.body, /<form method="post" action="\/_captcha\/verify">/);
  assert.match(res.body, /<img src="data:image\/png;base64,/);
  assert.match(res.body, /<audio controls preload="none" src="\/_captcha\/audio\.wav\?ct=/);
  assert.match(res.body, /href="\/_captcha\/style\.css\?v=[0-9a-f]{12}"/);
  assert.equal(formOf(res).next, '/deep/page?q=1&r=2');
  assert.ok(!res.body.includes('app:'));
});

test('solving sets a pass and returns the visitor to the page they asked for', async () => {
  const handler = withCaptchaGate(app, { secret, nonces: memoryNonceStore() });
  const solved = await solve(handler, '/deep/page?q=1');
  assert.equal(forwardTo(solved), '/deep/page?q=1');
  assert.equal(solved.headers['cache-control'], 'no-store');
  assert.match(solved.body, /role="status"><span class="spinner" aria-hidden="true"><\/span>Welcome\. Loading…/);
  assert.equal(solved.cookies?.length, 1);
  const setCookie = solved.cookies![0];
  assert.match(setCookie, /^__Host-captcha_pass=[^;]+; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$/);

  const pass = setCookie.split(';')[0];
  const res = await handler(event('GET', '/anything', { cookies: ['other=1', pass] }), {});
  assert.deepEqual(res, { statusCode: 200, headers: { 'cache-control': 'private' }, body: 'app:/anything' });

  // The raw Cookie header works too, for events that don't split cookies out.
  const viaHeader = await handler(event('POST', '/form', { headers: { Cookie: `a=b; ${pass}` } }), {});
  assert.equal((viaHeader as GateResponse).body, 'app:/form');
});

test('wrong and replayed answers re-render with a fresh challenge', async () => {
  const gate = createGate({ secret, nonces: memoryNonceStore() });

  const page = (await gate.handle(event('GET', '/x')))!;
  const { token, next } = formOf(page);
  const answer = answerForSecret(token, secret)!;

  const wrong = (await gate.handle(
    event('POST', '/_captcha/verify', { form: { ct: token, captcha: answer === '00000' ? '11111' : '00000', next } }),
  ))!;
  assert.equal(wrong.statusCode, 400);
  assert.match(wrong.body, /role="alert">Those digits didn&#39;t match/);
  assert.notEqual(formOf(wrong).token, token);
  assert.equal(formOf(wrong).next, '/x');

  const ok = (await gate.handle(event('POST', '/_captcha/verify', { form: { ct: token, captcha: answer, next } })))!;
  assert.equal(forwardTo(ok), '/x');

  const replay = (await gate.handle(event('POST', '/_captcha/verify', { form: { ct: token, captcha: answer, next } })))!;
  assert.equal(replay.statusCode, 400);
  assert.match(replay.body, /already used/);
});

test('a right answer that arrives late says so', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  t.after(() => mock.timers.reset());
  const gate = createGate({ secret, nonces: memoryNonceStore() });
  const { token, next } = formOf((await gate.handle(event('GET', '/')))!);
  const answer = answerForSecret(token, secret)!;
  mock.timers.tick(181_000);
  const res = (await gate.handle(event('POST', '/_captcha/verify', { form: { ct: token, captcha: answer, next } })))!;
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /expired/);
});

test('passes expire, and forged or foreign passes are refused', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  t.after(() => mock.timers.reset());
  const handler = withCaptchaGate(app, { secret, nonces: memoryNonceStore(), passTtlSeconds: 60 });
  const pass = (await solve(handler)).cookies![0].split(';')[0];
  const [name, value] = pass.split('=');

  assert.equal(((await handler(event('GET', '/', { cookies: [pass] }), {})) as GateResponse).statusCode, 200);
  assert.equal(((await handler(event('GET', '/', { cookies: [`${name}=${value}x`] }), {})) as GateResponse).statusCode, 403);

  // A pass minted under another secret is worthless here.
  const elsewhere = withCaptchaGate(app, { secret: 'another-secret', nonces: memoryNonceStore() });
  const page = (await elsewhere(event('GET', '/'), {})) as GateResponse;
  const { token, next } = formOf(page);
  const foreign = (await elsewhere(
    event('POST', '/_captcha/verify', { form: { ct: token, captcha: answerForSecret(token, 'another-secret')!, next } }),
    {},
  )) as GateResponse;
  const foreignPass = foreign.cookies![0].split(';')[0];
  assert.equal(((await handler(event('GET', '/', { cookies: [foreignPass] }), {})) as GateResponse).statusCode, 403);

  mock.timers.tick(61_000);
  assert.equal(((await handler(event('GET', '/', { cookies: [pass] }), {})) as GateResponse).statusCode, 403);
});

test('a challenge token is not a pass', async () => {
  const handler = withCaptchaGate(app, { secret, nonces: memoryNonceStore() });
  const { token } = formOf((await handler(event('GET', '/'), {})) as GateResponse);
  const res = (await handler(event('GET', '/', { cookies: [`__Host-captcha_pass=${token}`] }), {})) as GateResponse;
  assert.equal(res.statusCode, 403);
});

test('allow lets chosen requests through without a pass', async () => {
  const handler = withCaptchaGate(app, {
    secret,
    nonces: memoryNonceStore(),
    allow: ({ method, path }) => method === 'GET' && (path === '/robots.txt' || path === '/healthz'),
  });
  assert.equal(((await handler(event('GET', '/healthz'), {})) as GateResponse).body, 'app:/healthz');
  assert.equal(((await handler(event('POST', '/healthz'), {})) as GateResponse).statusCode, 403);
});

test('a non-GET request is challenged with a return to the root', async () => {
  const gate = createGate({ secret, nonces: memoryNonceStore() });
  assert.equal(formOf((await gate.handle(event('POST', '/save')))!).next, '/');
});

test('the gate serves its audio and stylesheet with or without a pass', async () => {
  const gate = createGate({ secret, nonces: memoryNonceStore() });
  const { token } = formOf((await gate.handle(event('GET', '/')))!);

  const audio = (await gate.handle(event('GET', `/_captcha/audio.wav?ct=${encodeURIComponent(token)}`)))!;
  assert.equal(audio.statusCode, 200);
  assert.equal(audio.headers['content-type'], 'audio/wav');
  assert.equal(audio.isBase64Encoded, true);
  assert.equal(Buffer.from(audio.body, 'base64').subarray(0, 4).toString(), 'RIFF');

  assert.equal((await gate.handle(event('GET', '/_captcha/audio.wav?ct=nope')))!.statusCode, 404);
  assert.equal((await gate.handle(event('GET', '/_captcha/audio.wav')))!.statusCode, 404);

  const css = (await gate.handle(event('GET', '/_captcha/style.css?v=x')))!;
  assert.equal(css.statusCode, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  assert.match(css.body, /\.captcha \{/);

  assert.equal((await gate.handle(event('GET', '/_captcha/other')))!.statusCode, 404);
  const getVerify = (await gate.handle(event('GET', '/_captcha/verify')))!;
  assert.equal(getVerify.statusCode, 303);
  assert.equal(getVerify.headers.location, '/');
});

test('a base64 form body is decoded', async () => {
  const gate = createGate({ secret, nonces: memoryNonceStore() });
  const { token, next } = formOf((await gate.handle(event('GET', '/b64')))!);
  const res = (await gate.handle(
    event('POST', '/_captcha/verify', { form: { ct: token, captcha: answerForSecret(token, secret)!, next }, base64: true }),
  ))!;
  assert.equal(forwardTo(res), '/b64');
});

test('options: prefix, cookie name, async secret, page text', async () => {
  let calls = 0;
  const handler = withCaptchaGate(app, {
    secret: async () => {
      calls++;
      return secret;
    },
    nonces: memoryNonceStore(),
    prefix: '/prod/_check',
    cookieName: 'gate',
    title: 'Hello <there>',
    intro: 'Prove it & go',
    lang: 'fr',
    digits: 6,
  });
  const page = (await handler(event('GET', '/prod/home'), {})) as GateResponse;
  assert.match(page.body, /action="\/prod\/_check\/verify"/);
  assert.match(page.body, /<title>Hello &lt;there&gt;<\/title>/);
  assert.match(page.body, /Prove it &amp; go/);
  assert.match(page.body, /<html lang="fr">/);
  assert.match(page.body, /maxlength="6"/);
  const { token, next } = formOf(page);
  const solved = (await handler(
    event('POST', '/prod/_check/verify', { form: { ct: token, captcha: answerForSecret(token, secret, 6)!, next } }),
    {},
  )) as GateResponse;
  assert.equal(forwardTo(solved), '/prod/home');
  assert.match(solved.body, /href="\/prod\/_check\/style\.css\?v=/);
  assert.match(solved.cookies![0], /^gate=/);
  assert.equal(calls, 1);
});

test('a secret that fails to load is retried on the next request', async () => {
  let calls = 0;
  const gate = createGate({
    secret: async () => {
      if (++calls === 1) throw new Error('secrets manager timeout');
      return secret;
    },
    nonces: memoryNonceStore(),
  });
  await assert.rejects(gate.handle(event('GET', '/')), /timeout/);
  assert.equal((await gate.handle(event('GET', '/')))!.statusCode, 403);
});

test('bad options fail at construction', () => {
  const nonces = memoryNonceStore();
  assert.throws(() => createGate({ secret, nonces, prefix: '_captcha' }), RangeError);
  assert.throws(() => createGate({ secret, nonces, prefix: '/_captcha/' }), RangeError);
  assert.throws(() => createGate({ secret, nonces, cookieName: 'a b' }), RangeError);
  assert.throws(() => createGate({ secret, nonces, passTtlSeconds: 0 }), RangeError);
  assert.throws(() => createGate({ secret, nonces, digits: 12 }), RangeError);
});

test('next is confined to this origin', () => {
  for (const ok of ['/', '/a', '/a/b?c=d&e=%2F%2Fx', '/a#frag', '/%2F%2Fevil.example']) {
    assert.equal(safeNext(ok), ok, ok);
  }
  for (const bad of [
    undefined,
    null,
    '',
    'a',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'https://evil.example/',
    'javascript:alert(1)',
    '/\t/evil.example',
    '/\n/evil.example',
    '/a\r\nSet-Cookie: x=1',
    `/${'a'.repeat(3000)}`,
  ]) {
    assert.equal(safeNext(bad), '/', JSON.stringify(bad));
  }
});

test('a request path of //host cannot become an open redirect', async () => {
  const handler = withCaptchaGate(app, { secret, nonces: memoryNonceStore() });
  const solved = await solve(handler, '//evil.example/x');
  assert.equal(forwardTo(solved), '/');

  // Nor can a forged next field.
  const page = (await handler(event('GET', '/'), {})) as GateResponse;
  const { token } = formOf(page);
  const forged = (await handler(
    event('POST', '/_captcha/verify', {
      form: { ct: token, captcha: answerForSecret(token, secret)!, next: 'https://evil.example/' },
    }),
    {},
  )) as GateResponse;
  assert.equal(forwardTo(forged), '/');
});

test("a quote in the destination can't cut the refresh URL short", async () => {
  const handler = withCaptchaGate(app, { secret, nonces: memoryNonceStore() });
  const solved = await solve(handler, "/it's?q='x'");
  assert.match(solved.body, /content="0; url=&#39;\/it%27s\?q=%27x%27&#39;"/);
  assert.equal(forwardTo(solved), "/it's?q='x'");
});

test('responses that pass the gate are kept out of shared caches', async () => {
  const cached = (cacheControl?: string) => async () => ({
    statusCode: 200,
    headers: cacheControl === undefined ? { 'Content-Type': 'text/html' } : { 'Cache-Control': cacheControl },
    body: 'app',
  });
  const passed = async (cacheControl?: string) => {
    const handler = withCaptchaGate(cached(cacheControl), { secret, nonces: memoryNonceStore() });
    const pass = (await solve(handler)).cookies![0].split(';')[0];
    return (await handler(event('GET', '/', { cookies: [pass] }), {})) as GateResponse;
  };

  // The app's own header name is kept, so the header isn't sent twice.
  assert.deepEqual((await passed('max-age=300')).headers, { 'Cache-Control': 'private, max-age=300' });
  assert.deepEqual((await passed('public, max-age=60, s-maxage=600')).headers, { 'Cache-Control': 'private, max-age=60' });
  assert.deepEqual((await passed('no-store')).headers, { 'Cache-Control': 'no-store' });
  assert.deepEqual((await passed()).headers, { 'Content-Type': 'text/html', 'cache-control': 'private' });

  assert.equal(markPrivate('plain string body'), 'plain string body');
  assert.equal(markPrivate(null), null);
  const original = { statusCode: 200, headers: { 'cache-control': 'max-age=5' }, body: '' };
  assert.equal(markPrivate(original).headers['cache-control'], 'private, max-age=5');
  assert.equal(original.headers['cache-control'], 'max-age=5', 'the input is not mutated');
});

test("verifyMethod 'get': the form submits by GET, for CloudFront with OAC", async () => {
  const handler = withCaptchaGate(app, { secret, nonces: memoryNonceStore(), verifyMethod: 'get' });
  const page = (await handler(event('GET', '/deep?x=1'), {})) as GateResponse;
  assert.match(page.body, /<form method="get" action="\/_captcha\/verify">/);
  const { token, next } = formOf(page);
  const query = new URLSearchParams({ captcha: answerForSecret(token, secret)!, ct: token, next }).toString();

  // POST isn't accepted in this mode.
  const posted = (await handler(
    event('POST', '/_captcha/verify', { form: { ct: token, captcha: answerForSecret(token, secret)!, next } }),
    {},
  )) as GateResponse;
  assert.equal(posted.statusCode, 303);
  assert.equal(posted.headers.location, '/');
  assert.equal(posted.cookies, undefined);

  const solved = (await handler(event('GET', `/_captcha/verify?${query}`), {})) as GateResponse;
  assert.equal(forwardTo(solved), '/deep?x=1');
  const pass = solved.cookies![0].split(';')[0];
  assert.equal(((await handler(event('GET', '/deep?x=1', { cookies: [pass] }), {})) as GateResponse).body, 'app:/deep');

  // The back button returns to the spent verify URL. With the pass, carry on.
  const back = (await handler(event('GET', `/_captcha/verify?${query}`, { cookies: [pass] }), {})) as GateResponse;
  assert.equal(back.statusCode, 303);
  assert.equal(back.headers.location, '/deep?x=1');

  // Without one, the spent challenge is refused like any replay.
  const replay = (await handler(event('GET', `/_captcha/verify?${query}`), {})) as GateResponse;
  assert.equal(replay.statusCode, 400);
  assert.match(replay.body, /already used/);
  assert.match(replay.body, /<form method="get"/);

  // A wrong answer re-renders with a fresh challenge.
  const fresh = formOf(replay);
  const wrongQuery = new URLSearchParams({ captcha: '0', ct: fresh.token, next: fresh.next }).toString();
  assert.equal(((await handler(event('GET', `/_captcha/verify?${wrongQuery}`), {})) as GateResponse).statusCode, 400);
});

test("verifyMethod 'post' (the default) ignores a GET to verify, and a passed visitor carries on", async () => {
  const handler = withCaptchaGate(app, { secret, nonces: memoryNonceStore() });
  const page = (await handler(event('GET', '/p'), {})) as GateResponse;
  assert.match(page.body, /<form method="post"/);
  const { token, next } = formOf(page);
  const answer = answerForSecret(token, secret)!;
  const viaGet = (await handler(event('GET', `/_captcha/verify?${new URLSearchParams({ ct: token, captcha: answer, next })}`), {})) as GateResponse;
  assert.equal(viaGet.headers.location, '/');
  assert.equal(viaGet.cookies, undefined);

  const form = { ct: token, captcha: answer, next };
  const solved = (await handler(event('POST', '/_captcha/verify', { form }), {})) as GateResponse;
  const pass = solved.cookies![0].split(';')[0];
  const resubmitted = (await handler(event('POST', '/_captcha/verify', { form, cookies: [pass] }), {})) as GateResponse;
  assert.equal(resubmitted.statusCode, 303);
  assert.equal(resubmitted.headers.location, '/p');
  assert.throws(() => createGate({ secret, nonces: memoryNonceStore(), verifyMethod: 'put' as never }), RangeError);
});

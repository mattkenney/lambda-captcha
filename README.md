# lambda-captcha

An image + audio CAPTCHA for server-rendered web apps on AWS Lambda, plus a gate
that puts an entire Lambda app behind it.

- **No runtime dependencies.** The PNG and WAV are written by hand on Node's
  standard library, so there are no native binaries and no TTS engine in the
  bundle, and no network calls at request time.
- **No client JavaScript.** Plain `<form>`, `<img>` and `<audio>`, so it works
  under `script-src 'none'` and on old or weak browsers.
- **Stateless challenges.** The answer is never in the page, and needs no
  storage until someone answers correctly. Then one conditional write makes
  that answer single-use.
- **Accessible.** Every challenge can also be heard: the same digits, spoken,
  at a route of their own.

## Gate a whole app

Wrap the Lambda handler. Until a visitor solves a challenge, every request gets
the challenge page instead of the app:

```ts
import { withCaptchaGate } from 'lambda-captcha';
import { dynamoNonceStore } from 'lambda-captcha/dynamodb';

export const handler = withCaptchaGate(app, {
  secret: () => loadSecretOnce(), // or a string
  nonces: dynamoNonceStore({ tableName: process.env.CAPTCHA_TABLE! }),
  allow: ({ method, path }) => method === 'GET' && path === '/robots.txt',
});
```

What a visitor sees:

1. Any request without a valid pass gets `403` and a small standalone page: the
   image, the audio player, an answer field, and a Continue button.
2. Solving it sets an `HttpOnly; Secure; SameSite=Lax` cookie, a signed pass
   that lasts 12 hours by default, and shows a brief "Welcome. Loading…" page
   that forwards them to the page they asked for.
3. A wrong, late or reused answer re-renders the page with a fresh challenge
   and says which one it was.

Responses from the app itself go out with `private` added to their
`Cache-Control` (see `markPrivate`), so a CDN can't serve one visitor's page to
another who hasn't passed.

The gate serves three routes of its own under `/_captcha` (see `prefix`):
`/verify` (POST, or GET; see `verifyMethod`), `GET /audio.wav` and
`GET /style.css`.

When something has to run before the gate (an origin-secret check, say), call
it from inside your own handler instead:

```ts
const gate = createGate({ secret, nonces });

export const handler = async (event: APIGatewayProxyEventV2) => {
  if (!fromCloudFront(event)) return forbidden();
  return (await gate.handle(event)) ?? markPrivate(await app(event));
};
```

### Gate options

| Option | Default | |
| --- | --- | --- |
| `secret` | required | String, or a function returning one (sync or async). A function is called once per container. If it rejects, the next request calls it again. |
| `nonces` | required | A `NonceStore`. Use `dynamoNonceStore` in production. |
| `passTtlSeconds` | `43200` (12 h) | How long one solve grants access. |
| `cookieName` | `__Host-captcha_pass` | |
| `prefix` | `/_captcha` | Where the gate's own routes live. Behind an API Gateway stage other than `$default`, include the stage, e.g. `/prod/_captcha`. |
| `verifyMethod` | `post` | `get` for a Function URL behind CloudFront with OAC (see below). POST keeps answers out of URLs and logs. |
| `allow` | none | `({ method, path }) => boolean`. Requests to let through without a pass: health checks, webhooks, `robots.txt`. |
| `digits` | `5` | 4–8. |
| `challengeTtlSeconds` | `180` | How long one challenge can be answered. |
| `title`, `intro`, `lang` | English | Text of the challenge page. |

## Embed a challenge in your own form

For gating one action (a sign-in, a sign-up, a contact form) rather than the
whole app:

```ts
import { createCaptcha, renderFields, ANSWER_FIELD, TOKEN_FIELD } from 'lambda-captcha';
import { dynamoNonceStore } from 'lambda-captcha/dynamodb';

const captcha = createCaptcha({ secret, nonces: dynamoNonceStore({ tableName }) });

// Rendering the form: a fresh challenge per render, never cached.
const c = captcha.issue();
const page = `<form method="post" action="/signup">
  …your fields…
  ${renderFields(c, { audioUrl: '/captcha.wav' })}
  <button type="submit">Sign up</button>
</form>`;

// GET /captcha.wav?ct=<token>: the same challenge, spoken.
const wav = captcha.audio(query.get(TOKEN_FIELD)); // Buffer, or undefined → 404
// Return it as audio/wav, base64 with isBase64Encoded: true.

// Handling the POST.
switch (await captcha.verify(form.get(TOKEN_FIELD), form.get(ANSWER_FIELD))) {
  case 'ok':      /* proceed */ break;
  case 'expired': /* "That image expired — here is a new one." */ break;
  case 'used':    /* "That image was already used — here is a new one." */ break;
  case 'wrong':
  case 'invalid': /* "Those digits didn't match." */ break;
}
```

`renderFields` emits a label, the image, its audio alternative, the answer
input (`name="captcha"`) and the hidden token (`name="ct"`). It is unstyled
apart from its classes: include `CAPTCHA_CSS`, or style `.captcha`,
`.captcha-alt` and `.captcha-alt-label` yourself.

On anything other than `ok`, re-render with a **new** challenge.

## What it needs from your stack

**A secret.** At least 32 random bytes (`openssl rand -base64 48`), the same in
every container. Either:

- a Lambda environment variable, or
- a Secrets Manager secret read at cold start (pass `secret` a function).

Create it once and keep it: replacing it invalidates every live challenge and
pass. If it's missing, fail at cold start (`throw` at module load). Don't fall
back to a random per-container value: each container would then reject the
passes the others issued.

It can be the same key you sign your own cookies with. The package only ever
uses keys derived from it, one per purpose
(`HMAC(secret, "lambda-captcha/<purpose>")`), so its tokens and yours can never
be swapped for each other.

As an environment variable, anyone who can read the function's configuration
can read the secret. So does anyone who sees the output of
`aws lambda update-function-code` or `update-function-configuration`, which
print the whole configuration. Give those commands a `--query` in deploy
scripts.

**A nonce table.** Any DynamoDB table with a string partition key and TTL
turned on. With CDK:

```ts
const captchaTable = new dynamodb.Table(this, 'CaptchaNonces', {
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: 'ttl',
});
captchaTable.grant(fn, 'dynamodb:PutItem');
```

Or with the AWS CLI. Afterwards, allow `dynamodb:PutItem` on the table for the
function's role:

```sh
aws dynamodb create-table --table-name captcha-nonces \
  --attribute-definitions AttributeName=pk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
aws dynamodb update-time-to-live --table-name captcha-nonces \
  --time-to-live-specification Enabled=true,AttributeName=ttl
```

To use an existing single-table design instead, pass `key` (and `ttlAttribute`
if yours isn't `ttl`):

```ts
dynamoNonceStore({ tableName, key: (n) => ({ PK: `CAPTCHA#${n}`, SK: 'USED' }) });
```

`memoryNonceStore()` exists for tests and local runs. It is **not** replay-safe
on Lambda, because each concurrent container has its own memory.

**Bundling.** The AWS SDK is an optional peer dependency, used only by
`lambda-captcha/dynamodb`. The Lambda Node.js runtime already provides it, so
mark `@aws-sdk/*` external (`NodejsFunction` does this with
`bundling.externalModules`).

The package ships TypeScript source, with no compiled build, so the app has to
bundle it. esbuild does that from `node_modules` with no configuration, into
either an ES module or CommonJS handler (`NodejsFunction` uses esbuild too).
Plain Node.js without a bundler can't load it.

**CloudFront in front of the gate.** The behavior that routes to the Lambda
must:

- forward cookies, or no pass is ever seen and every request is challenged
- forward the query string (the audio route, and verify with `verifyMethod: 'get'`)
- allow POST, with the default `verifyMethod: 'post'`

`AllViewerExceptHostHeader` as the origin request policy forwards both cookies
and query strings for a Function URL. The cache policy must also have a
**minimum TTL of 0**: CloudFront honours `private` and `no-store` only then.
Above 0, it caches gated pages and challenge pages regardless. `CachingDisabled`
is the simplest choice.

**Function URLs behind an origin access control (OAC)** (auth type `AWS_IAM`,
with CloudFront signing each request) need `verifyMethod: 'get'`. Lambda
requires a POST through OAC to carry a SHA-256 hash of its body in
`x-amz-content-sha256`. CloudFront doesn't add that header and an HTML form
can't send it, so the verify POST is refused with:

```
{"message":"The request signature we calculated does not match the signature you provided. …"}
```

With GET, the token and answer travel in the URL, which puts them in browser
history and in any log that records query strings. That's harmless: a
challenge works once and expires within minutes. The alternative is to drop
OAC, using auth type `NONE`, and keep direct calls out with a secret header that
CloudFront adds and the handler checks.

**CSP.** Gate pages send their own `Content-Security-Policy`. If a CDN policy
overrides it, it must still allow `img-src data:`, `media-src 'self'`,
`style-src 'self'` and `form-action 'self'`. Embedded fields need `img-src data:`
and a `media-src` that covers your audio route.

**Event shape.** Payload format 2.0, which is what Lambda Function URLs and API
Gateway HTTP APIs send. REST APIs (payload 1.0) and ALB events are not
supported.

**Local development.** A dev server has to hand the gated handler the same
events, for every method and path, not just `GET /`. Serve the static files
first, as CloudFront does in production, since they never reach the gate there.
With Express 5:

```js
process.env.CAPTCHA_SECRET ??= 'local-dev-only'; // fixed, so passes survive restarts
const { handler } = await import('./dist/index.mjs');

app.use(express.static('public'));
app.use(express.text({ type: '*/*' }), async (req, res) => {
  const url = new URL(req.originalUrl, 'http://localhost');
  const out = await handler({
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    queryStringParameters: Object.fromEntries(url.searchParams),
    cookies: req.headers.cookie?.split(/;\s*/),
    headers: req.headers,
    body: typeof req.body === 'string' ? req.body : undefined,
    isBase64Encoded: false,
    requestContext: { http: { method: req.method } },
  });
  res.status(out.statusCode).set(out.headers);
  for (const cookie of out.cookies ?? []) res.append('Set-Cookie', cookie);
  res.send(out.isBase64Encoded ? Buffer.from(out.body, 'base64') : out.body);
});
```

The pass cookie is `Secure`. Chrome and Firefox accept it from
`http://localhost` anyway.

## Limits and trade-offs

- **The gate covers what the Lambda serves, nothing else.** Static assets that
  CloudFront fetches straight from S3 never reach it. Gated responses are marked
  `private` and the gate's own pages `no-store`, but a cache configured to
  ignore those (see above) will still share them.
- **A pass is a bearer token.** A person can solve one challenge and hand the
  cookie to a bot for the rest of `passTtlSeconds`. The gate makes automated
  access cost more; it does not prove that each request comes from a human.
- **A POST without a pass loses its body.** There's no way to carry it through
  the challenge without script. The visitor lands on `/` after solving.
- **Wrong answers don't spend a challenge.** Only a correct answer burns the
  nonce, so a determined client can brute-force one token within its TTL: on
  average half of 10^digits guesses (50,000 at five digits). That is far more
  work than reading the image, but more `digits` or a shorter TTL raises the
  cost further.
- **The audio is the weaker path, deliberately.** See below.
- **English.** The gate page's title, intro and `lang` are options. The field
  labels are fixed.

## Design notes

- **Runtime image generation, no dependency.** `src/image.ts` rasterises the
  digits into an 8-bit greyscale PNG. Digits are stroke outlines in a unit box,
  not a bitmap font, because a 5x7 bitmap breaks into disconnected squares at
  ~50px. Each pixel is drawn by inverse mapping, then the image is distorted:
  - an independent sine wave on each axis
  - per-glyph rotation, shear and scale, in overlapping cells
  - strike-through lines that follow the same wave
  - mottled paper
  - a Gaussian defocus over the whole frame, at a random radius, so no fixed
    sharpening kernel can be calibrated against it

  The PNG has an alpha channel whose outer 14px fade (smoothstep) to fully
  transparent. The image dissolves into the page instead of sitting on it as a
  hard rectangle, and reads on a light or a dark background, because the light
  "paper" fades out too. A margin keeps every digit out of that fade band. It
  uses one sample per pixel, not 2x2: the defocus already does the
  anti-aliasing that supersampling would pay four times over for. The image is
  240x100 at five digits, and each extra digit adds 36px of width.
  `sharp` and `node-canvas` were rejected: they drag native binaries into an
  otherwise pure-JS bundle, on Lambdas tuned for cold start. Node's zlib is the
  only hard part, and it is in the standard library.
- **The answer is never in the page.** The form carries the rendering and a
  signed token holding a random *seed*. The digits are `HMAC(key, seed)` reduced
  mod 10, with rejection sampling: bytes ≥ 250 are dropped, because taking every
  byte mod 10 would over-represent 0-5. The seed is public, but expanding it
  needs the key, so reading the HTML tells an attacker nothing. A wrong answer is
  rejected before any I/O, at the cost of one HMAC.
- **Why a seed and not a hash of the answer.** A commitment such as
  `HMAC(nonce + answer)` can only *check* an answer, never recover one, so no
  second route could re-render the same challenge. Deriving the digits from a
  seed lets the audio route regenerate the identical digits from the same
  token, with no shared state and no extra storage. The seed doubles as the
  one-shot nonce.
- **Challenges are single-use and short-lived** (3 minutes by default). A
  correct answer burns the seed through `NonceStore.consume`, an atomic
  conditional write. Without that, a solved (token, answer) pair could be
  replayed for the whole TTL, which for a relay is all an attacker needs.
- **Expiry is reported as expiry.** On a short TTL, a real person filling in a
  form will sometimes be late. Expiry is checked *after* the answer, so a
  correct but late answer gets "that image expired" rather than being called a
  typo.
- **A "Loading" page after a solve, not a redirect.** With a `303`, the
  browser keeps the solved challenge on screen until the app's page arrives.
  For a slow app that looks as if the answer did nothing. The gate instead
  answers at once with a short page that sets the pass and forwards with
  `<meta http-equiv="refresh" content="0; url='…'">`. The browser keeps that
  page on screen while it fetches the destination. A meta refresh needs no
  script, no CSP directive governs it, and every browser supports it. A
  `Continue` link covers browsers with refresh turned off (an opt-in setting in
  Firefox, for instance). Its quoted URL percent-encodes `'`, so a quote in
  the destination can't end it early.
- **Audio alternative.** The fields embed a plain
  `<audio controls preload="none">`. It needs no script, fetches nothing unless
  played, and wraps a download link for browsers without `<audio>`. A bare
  hyperlink was tried first and was wrong: Firefox downloads the file, and
  Chrome navigates away from the form, losing whatever the user had typed. The
  audio route is public and session-free by necessity, but it speaks only the
  digits of a live, signed token, so it can't be used to mint answers offline.
  Binary bodies go back base64 with `isBase64Encoded`, or the Function URL
  mangles them.
- **Spoken digits are a build input, not a runtime dependency.**
  `scripts/gen-clips.sh` makes ten espeak-ng recordings at a deliberately slow
  speaking rate. It trims them and resamples to 11 kHz, since 8 kHz telephone
  bandwidth smears the consonants that separate "six" from "seven". It then
  peak-normalises them, reduces them to 8-bit and deflates them into
  `src/clips.ts` (~50 KB, inflated once per container). WAV needs no
  compression: it is a 44-byte RIFF header over raw PCM.
- **The audio track is the weaker path, deliberately.** Speech recognition
  beats audio CAPTCHAs far more reliably than OCR beats visual ones, so the
  effective strength is `min(visual, audio)`, and an attacker who bothers will
  take the audio. The mitigations go as far as is reasonable: per-digit
  varispeed, uneven gaps, a low-passed noise floor, tremolo, and quiet
  distractor digits fitted entirely inside the gaps. The distractors, not the
  noise, are what actually trouble a recogniser. The weakness is accepted: the
  aim is to be unprofitable for breadth-based abuse, not unbreakable, and
  locking out people who can't read the image is the worse failure.

## Development

```sh
npm test            # node:test, via ts-node
npm run typecheck
npm run gen-clips   # regenerate src/clips.ts (needs espeak-ng and python3)
```

## Installing

The package is `private`, so it is not published to a registry. Install it from
git:

```sh
npm install github:mattkenney/lambda-captcha
```

There is no build step, so no install script has to run, and it works with
npm's `ignore-scripts` turned on. npm pins the dependency to the commit it
installed: run `npm update lambda-captcha` to pick up newer ones.

A TypeScript app type-checks the package's source along with its own. It
compiles under `strict` with `noUnusedLocals` and `noUnusedParameters`.
Options stricter than that may report errors in it.

## License

GNU Affero General Public License, version 3 or later — see [LICENSE](./LICENSE).
Note what that means for a library: an app that links it and is offered to
users over a network takes on the AGPL's source-availability terms.

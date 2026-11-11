import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createCaptcha, memoryNonceStore, renderFields, type NonceStore } from '../src/index';
import { answerForSecret } from '../src/challenge';
import { renderPng } from '../src/image';
import { renderWav } from '../src/audio';
import { read, sign, subkey } from '../src/token';

const secret = 'test-secret-0123456789abcdef0123456789abcdef';

function pngSize(png: Buffer): { width: number; height: number } {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test('issue renders a PNG of the advertised size, and the token answers it', async () => {
  const captcha = createCaptcha({ secret, nonces: memoryNonceStore() });
  const c = captcha.issue();
  assert.equal(c.digits, 5);
  assert.deepEqual({ width: c.width, height: c.height }, { width: 240, height: 100 });
  assert.match(c.image, /^data:image\/png;base64,/);
  assert.deepEqual(pngSize(Buffer.from(c.image.split(',')[1], 'base64')), { width: 240, height: 100 });

  const answer = answerForSecret(c.token, secret);
  assert.match(answer!, /^\d{5}$/);
  assert.equal(await captcha.verify(c.token, answer), 'ok');
});

test('the image widens with the digit count', () => {
  assert.deepEqual(pngSize(renderPng('1234')), { width: 204, height: 100 });
  assert.deepEqual(pngSize(renderPng('12345678')), { width: 348, height: 100 });
  for (const digits of [4, 8]) {
    const c = createCaptcha({ secret, nonces: memoryNonceStore(), digits }).issue();
    assert.equal(answerForSecret(c.token, secret, digits)!.length, digits);
  }
});

test('rejects out-of-range settings', () => {
  const nonces = memoryNonceStore();
  assert.throws(() => createCaptcha({ secret, nonces, digits: 3 }), RangeError);
  assert.throws(() => createCaptcha({ secret, nonces, digits: 9 }), RangeError);
  assert.throws(() => createCaptcha({ secret, nonces, ttlSeconds: 0 }), RangeError);
  assert.throws(() => createCaptcha({ secret: '', nonces }), TypeError);
});

test('the token carries only a random seed and an expiry, never the answer', () => {
  const c = createCaptcha({ secret, nonces: memoryNonceStore() }).issue();
  const payload = JSON.parse(Buffer.from(c.token.split('.')[0], 'base64').toString());
  assert.deepEqual(Object.keys(payload), ['s', 'exp']);
  assert.match(payload.s, /^[A-Za-z0-9_-]{16}$/);
});

test('wrong, forged and missing answers are told apart from expiry', async () => {
  const captcha = createCaptcha({ secret, nonces: memoryNonceStore() });
  const c = captcha.issue();
  const answer = answerForSecret(c.token, secret)!;
  const wrong = answer.replace(/./, (d) => String((Number(d) + 1) % 10));
  assert.equal(await captcha.verify(c.token, wrong), 'wrong');
  assert.equal(await captcha.verify(c.token, answer.slice(1)), 'wrong');
  assert.equal(await captcha.verify(c.token, ''), 'wrong');
  assert.equal(await captcha.verify(c.token, null), 'wrong');
  assert.equal(await captcha.verify(undefined, answer), 'invalid');
  assert.equal(await captcha.verify('garbage', answer), 'invalid');
  assert.equal(await captcha.verify(`${c.token}x`, answer), 'invalid');

  // Another secret's token doesn't verify.
  const other = createCaptcha({ secret: 'some-other-secret', nonces: memoryNonceStore() }).issue();
  assert.equal(await captcha.verify(other.token, answerForSecret(other.token, 'some-other-secret')), 'invalid');

  // A wrong guess doesn't spend the challenge; whitespace is forgiven.
  assert.equal(await captcha.verify(c.token, ` ${answer.split('').join(' ')} `), 'ok');
});

test('a solved challenge is accepted once', async () => {
  const captcha = createCaptcha({ secret, nonces: memoryNonceStore() });
  const c = captcha.issue();
  const answer = answerForSecret(c.token, secret)!;
  const results = await Promise.all([captcha.verify(c.token, answer), captcha.verify(c.token, answer)]);
  assert.deepEqual(results.sort(), ['ok', 'used']);
});

test('a right answer after the TTL reports expired, not wrong', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  t.after(() => mock.timers.reset());
  const captcha = createCaptcha({ secret, nonces: memoryNonceStore(), ttlSeconds: 60 });
  const c = captcha.issue();
  const answer = answerForSecret(c.token, secret)!;
  mock.timers.tick(61_000);
  assert.equal(await captcha.verify(c.token, answer), 'expired');
  assert.equal(await captcha.verify(c.token, answer === '00000' ? '11111' : '00000'), 'wrong');
  assert.equal(captcha.audio(c.token), undefined);
});

test('a store failure surfaces instead of passing the challenge', async () => {
  const failing: NonceStore = { consume: async () => Promise.reject(new Error('table down')) };
  const captcha = createCaptcha({ secret, nonces: failing });
  const c = captcha.issue();
  await assert.rejects(captcha.verify(c.token, answerForSecret(c.token, secret)), /table down/);
});

test('audio speaks a live token and refuses a forged one', () => {
  const captcha = createCaptcha({ secret, nonces: memoryNonceStore() });
  const wav = captcha.audio(captcha.issue().token)!;
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(captcha.audio('forged.token'), undefined);
  assert.equal(captcha.audio(undefined), undefined);
  // Longer answers make longer audio.
  assert.ok(renderWav('12345678').length > renderWav('1234').length);
});

test('keys are separated by purpose', () => {
  // A token signed for one purpose never reads under another's key, so the
  // caller's secret can safely be shared with its own cookie signing.
  const token = sign({ s: 'seed' }, 60, subkey(secret, 'challenge-token'));
  assert.ok(read(token, subkey(secret, 'challenge-token')));
  assert.equal(read(token, subkey(secret, 'pass')), undefined);
});

test('renderFields emits the named fields, an escaped audio URL, and no answer', () => {
  const captcha = createCaptcha({ secret, nonces: memoryNonceStore() });
  const c = captcha.issue();
  const html = renderFields(c, { audioUrl: '/a/audio.wav?x=1' });
  assert.match(html, /name="captcha"/);
  assert.match(html, new RegExp(`name="ct" value="${c.token.replace(/[.]/g, '\\.')}"`));
  assert.match(html, /src="\/a\/audio\.wav\?x=1&amp;ct=/);
  assert.match(html, /maxlength="5"/);
  assert.match(html, /placeholder="_ _ _ _ _"/);
  assert.match(html, /<audio controls preload="none"/);
});

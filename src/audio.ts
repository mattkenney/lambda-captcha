import { inflateSync } from 'node:zlib';
import { CLIP_BLOB_B64, CLIP_LENGTHS, CLIP_RATE } from './clips';

/**
 * Audio rendering of the CAPTCHA (README.md, "Design notes") — the accessible
 * alternative to the image, served from its own route so it costs nothing for
 * anyone who doesn't ask for it.
 *
 * Like the image, this is hand-rolled: WAV is a 44-byte header over raw PCM, so
 * unlike the PNG it doesn't even need zlib to write. The spoken digits are a
 * *build* input (scripts/gen-clips.sh, espeak-ng) baked into the bundle,
 * so the Lambda needs no TTS engine and makes no network call.
 */

/** Inflated once per container, not per request. */
let clips: Uint8Array[] | undefined;

function digitClips(): Uint8Array[] {
  if (!clips) {
    const pcm = inflateSync(Buffer.from(CLIP_BLOB_B64, 'base64'));
    clips = [];
    let at = 0;
    for (const len of CLIP_LENGTHS) {
      clips.push(new Uint8Array(pcm.buffer, pcm.byteOffset + at, len));
      at += len;
    }
  }
  return clips;
}

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

/**
 * Resamples a clip by `rate`, which shifts pitch and tempo together the way a
 * varispeed tape does. Per-digit variation means the same digit never sounds
 * twice alike, so a solver can't match against ten fixed templates.
 */
function varispeed(clip: Uint8Array, rate: number): Float64Array {
  const out = new Float64Array(Math.floor(clip.length / rate));
  for (let i = 0; i < out.length; i++) {
    const at = i * rate;
    const j = Math.floor(at);
    const frac = at - j;
    // Signed 8-bit, linearly interpolated.
    const a = (clip[j] << 24) >> 24;
    const b = (clip[Math.min(clip.length - 1, j + 1)] << 24) >> 24;
    out[i] = (a + (b - a) * frac) * 256;
  }
  return out;
}

interface Gap {
  start: number;
  len: number;
  /** Digits either side, so a distractor never doubles one of them. */
  neighbours: number[];
}

/** Renders `answer` as a distorted spoken WAV. */
export function renderWav(answer: string): Buffer {
  const src = digitClips();

  const lead = Math.floor(CLIP_RATE * rand(0.3, 0.5));
  const spoken: { at: number; samples: Float64Array; gain: number }[] = [];
  const gaps: Gap[] = [];

  let at = lead;
  for (let i = 0; i < answer.length; i++) {
    const digit = Number(answer[i]);
    // Narrow range: enough that the same digit never sounds twice alike, but not
    // so wide that it hurts a listener trying to make the word out.
    const samples = varispeed(src[digit], rand(0.94, 1.07));
    spoken.push({ at, samples, gain: rand(0.85, 1) });
    at += samples.length;

    const len = Math.floor(CLIP_RATE * rand(0.4, 0.75));
    const next = i + 1 < answer.length ? Number(answer[i + 1]) : -1;
    gaps.push({ start: at, len, neighbours: [digit, next] });
    at += len;
  }
  const total = at + Math.floor(CLIP_RATE * rand(0.3, 0.5));

  const mix = new Float64Array(total);
  for (const s of spoken) {
    for (let i = 0; i < s.samples.length; i++) mix[s.at + i] += s.samples[i] * s.gain;
  }

  // Distractor voices: other digits spoken quietly, each fitted entirely inside
  // one gap. Overlapping a real digit — or repeating one next to itself — is
  // what a listener hears as an echo, so both are ruled out by construction
  // rather than left to chance.
  for (const gap of gaps) {
    if (Math.random() > 0.55) continue;
    const choices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => !gap.neighbours.includes(d));
    const digit = choices[Math.floor(Math.random() * choices.length)];
    const room = gap.len * 0.8;
    // Speed the distractor up just enough to fit the gap; if that would need an
    // unnatural rate, skip this gap rather than truncate a word mid-syllable.
    const rate = src[digit].length / room;
    if (rate < 0.85 || rate > 1.7) continue;

    const samples = varispeed(src[digit], rate);
    const start = gap.start + Math.floor((gap.len - samples.length) / 2);
    const gain = rand(0.07, 0.13);
    const fade = Math.floor(samples.length * 0.15);
    for (let i = 0; i < samples.length; i++) {
      // Fade the edges, or the abrupt starts read as clicks.
      const env = Math.min(1, i / fade, (samples.length - i) / fade);
      mix[start + i] += samples[i] * gain * env;
    }
  }

  // Low-passed noise floor — softer on the ear than white noise, and it masks
  // the clip boundaries so the digits can't be split apart by silence alone.
  let brown = 0;
  const noiseGain = rand(1400, 2800);
  for (let i = 0; i < total; i++) {
    brown = brown * 0.86 + (Math.random() * 2 - 1) * 0.14;
    mix[i] += brown * noiseGain;
  }

  // A slow tremolo, so amplitude normalisation can't flatten the track.
  const tremFreq = rand(0.6, 1.6);
  const out = new Int16Array(total);
  for (let i = 0; i < total; i++) {
    const trem = 1 - 0.14 * Math.sin((2 * Math.PI * tremFreq * i) / CLIP_RATE);
    const v = mix[i] * trem;
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
  }

  return wav(out);
}

/** WAV container: 44-byte RIFF header, then the samples. No compression. */
function wav(samples: Int16Array): Buffer {
  const bytes = samples.length * 2;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + bytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); // fmt chunk length
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(CLIP_RATE, 24);
  h.writeUInt32LE(CLIP_RATE * 2, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(bytes, 40);
  return Buffer.concat([h, Buffer.from(samples.buffer, samples.byteOffset, bytes)]);
}

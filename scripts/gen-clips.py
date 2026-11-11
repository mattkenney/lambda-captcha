#!/usr/bin/env python3
"""Turns espeak-ng digit recordings into src/clips.ts.

Driven by gen-clips.sh, which supplies a directory of raw_0..raw_9.wav
at espeak's native 22050 Hz. Here each clip is trimmed to the spoken word,
resampled to 11025 Hz — 8 kHz telephone bandwidth smears the consonants that
separate the digits ("six"/"seven", "three"/"free"), which is the main thing that
makes a spoken digit unclear — peak
normalised so no digit is quieter than another, and reduced to 8-bit — the
runtime mixes noise over the top, which buries the extra quantisation floor.
"""
import base64
import json
import struct
import sys
import textwrap
import wave
import zlib

SRC_RATE, DST_RATE = 22050, 11025
RATIO = SRC_RATE / DST_RATE
OUT = "src/clips.ts"


def read(path):
    with wave.open(path) as w:
        assert w.getframerate() == SRC_RATE and w.getnchannels() == 1 and w.getsampwidth() == 2
        n = w.getnframes()
        return list(struct.unpack(f"<{n}h", w.readframes(n)))


def trim(s, frac=0.02, pad=200):
    """Drops leading/trailing silence, keeping a little padding either side."""
    peak = max(abs(v) for v in s) or 1
    thr = peak * frac
    a = next((i for i, v in enumerate(s) if abs(v) > thr), 0)
    b = next((i for i in range(len(s) - 1, -1, -1) if abs(s[i]) > thr), len(s) - 1)
    return s[max(0, a - pad) : min(len(s), b + pad)]


def resample(s):
    """Box-averages the source window feeding each output sample — a crude
    low-pass, but enough to stop decimation aliasing speech."""
    out = []
    for i in range(int(len(s) / RATIO)):
        lo = int(i * RATIO)
        hi = max(lo + 1, int((i + 1) * RATIO))
        win = s[lo:hi]
        out.append(sum(win) / len(win) if win else 0)
    return out


def normalise(s, target=0.88):
    peak = max(abs(v) for v in s) or 1
    gain = (32767 * target) / peak
    return [max(-32768, min(32767, int(v * gain))) for v in s]


def main(src_dir):
    clips = []
    for d in range(10):
        s = normalise(resample(trim(read(f"{src_dir}/raw_{d}.wav"))))
        clips.append(bytes((max(-128, min(127, v >> 8)) & 0xFF) for v in s))
        print(f"  {d}: {len(s) / DST_RATE:.2f}s  {len(clips[-1])} bytes")

    blob = base64.b64encode(zlib.compress(b"".join(clips), 9)).decode()
    body = "\n".join(f"  '{line}' +" for line in textwrap.wrap(blob, 96)).rstrip(" +") + ";"
    lengths = json.dumps([len(c) for c in clips])

    with open(OUT, "w") as f:
        f.write(
            f"""/**
 * GENERATED FILE — do not edit by hand.
 *
 * Spoken digits 0-9 for the audio CAPTCHA (README.md), 11 kHz 8-bit signed
 * mono PCM, deflate-compressed and base64'd so ten clips cost ~31 KB of bundle
 * instead of much more. Inflated once per container, not per request.
 *
 * Regenerate with: scripts/gen-clips.sh
 */

/** Byte length of each digit's clip, in order 0-9. */
export const CLIP_LENGTHS: readonly number[] = {lengths};

export const CLIP_RATE = {DST_RATE};

export const CLIP_BLOB_B64 =
{body}
"""
        )


if __name__ == "__main__":
    main(sys.argv[1])

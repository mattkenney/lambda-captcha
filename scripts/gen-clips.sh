#!/usr/bin/env bash
# Regenerates src/clips.ts — the spoken digits for the audio CAPTCHA.
#
# Speed 130 rather than espeak's default: the digits are single short words and
# slower articulation is the cheapest clarity win available.
#
# Requires espeak-ng. Output is deliberately committed: the clips are a build
# input, not a runtime dependency, so the Lambda needs no TTS and no network.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

i=0
for w in zero one two three four five six seven eight nine; do
  espeak-ng -v en-us -s 130 -p 45 -w "$tmp/raw_$i.wav" "$w"
  i=$((i+1))
done

python3 scripts/gen-clips.py "$tmp"
echo "wrote src/clips.ts"

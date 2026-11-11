import type { Challenge } from './challenge';

/** Form field carrying the typed digits. */
export const ANSWER_FIELD = 'captcha';
/** Form field (and audio query parameter) carrying the challenge token. */
export const TOKEN_FIELD = 'ct';

export interface FieldsOptions {
  /**
   * A route that serves `captcha.audio(token)` as `audio/wav`. The token is
   * appended as `?ct=…`. Required, not optional: without it the challenge
   * locks out anyone who can't read the image.
   */
  audioUrl: string;
}

/** HTML-escapes text for element content or a quoted attribute. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The CAPTCHA's form controls, to drop inside your own `<form>`: a label, the
 * image, its audio alternative, the answer input and the hidden token. Submit
 * the form and pass the two fields to `captcha.verify(token, answer)`.
 *
 * Needs no script, so it works under `script-src 'none'`. The image is a
 * `data:` URI, so your CSP needs `img-src data:`. Styled by CAPTCHA_CSS, or by
 * your own rules for the same classes.
 */
export function renderFields(c: Challenge, options: FieldsOptions): string {
  // A bare link to audio/wav is handled inconsistently — Firefox downloads it,
  // Chrome navigates away from the form and loses the user's typing. <audio> is
  // plain HTML (no script) and plays in place. preload="none" keeps it from
  // being fetched by anyone who never plays it; the inner link is the fallback
  // for a browser without <audio>.
  const sep = options.audioUrl.includes('?') ? '&' : '?';
  const audio = esc(`${options.audioUrl}${sep}${TOKEN_FIELD}=${encodeURIComponent(c.token)}`);
  const placeholder = Array<string>(c.digits).fill('_').join(' ');
  return `<label for="captcha-input">Type the ${c.digits} digits shown</label>
<div class="captcha">
  <img src="${c.image}" width="${c.width}" height="${c.height}"
       alt="Verification image containing ${c.digits} digits. Use the audio version if you cannot read it.">
  <div class="captcha-alt">
    <p class="captcha-alt-label" id="captcha-audio-label">Or listen to the digits</p>
    <audio controls preload="none" src="${audio}" aria-labelledby="captcha-audio-label">
      <a href="${audio}">Download the spoken digits (WAV)</a>
    </audio>
  </div>
</div>
<input id="captcha-input" type="text" name="${ANSWER_FIELD}" inputmode="numeric" pattern="[0-9]*"
       maxlength="${c.digits}" autocomplete="off" required placeholder="${placeholder}">
<input type="hidden" name="${TOKEN_FIELD}" value="${esc(c.token)}">`;
}

/**
 * Layout for renderFields' markup. The image and its audio alternative sit side
 * by side, and wrap to one column when there isn't room for both. Colours are
 * inherited, so it reads on a light or a dark page — the image's own background
 * fades out to transparent at its edges.
 */
export const CAPTCHA_CSS = `.captcha {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
}
.captcha > img {
  max-width: 100%;
  height: auto;
}
.captcha-alt {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}
.captcha-alt-label {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.75;
}
.captcha-alt audio {
  max-width: 100%;
  width: 15rem;
  height: 2.25rem;
}
`;

import { createHash } from 'node:crypto';
import type { Challenge } from './challenge';
import { CAPTCHA_CSS, esc, renderFields } from './fields';

/**
 * The gate's own challenge page: a complete, standalone document, since it is
 * shown in place of whatever the app would have served.
 *
 * No script, and no inline style either: the stylesheet is served from the
 * gate's own route, so the page works under a CSP of `style-src 'self'`, which
 * is what most apps already have.
 */

export const PAGE_CSS = `:root {
  color-scheme: light dark;
  --fg: #1d2129;
  --bg: #f6f7f9;
  --card: #ffffff;
  --muted: #5b6270;
  --line: #c9ced6;
  --accent: #1f5fbf;
  --accent-fg: #ffffff;
  --alert: #a3261b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e5e8ee;
    --bg: #14171c;
    --card: #1d2128;
    --muted: #a2a9b5;
    --line: #3b414c;
    --accent: #6ea2f2;
    --accent-fg: #0d1117;
    --alert: #ff8a7d;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2rem 1rem;
  font: 1rem/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--fg);
  background: var(--bg);
}
main {
  max-width: 28rem;
  margin: 0 auto;
  padding: 1.5rem;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 0.5rem;
}
h1 { margin: 0 0 0.5rem; font-size: 1.4rem; }
p { margin: 0 0 1rem; }
.intro { color: var(--muted); }
[role="alert"] { color: var(--alert); font-weight: 600; }
label { display: block; margin-bottom: 0.5rem; font-weight: 600; }
input[type="text"] {
  display: block;
  width: 100%;
  max-width: 15rem;
  margin-bottom: 1rem;
  padding: 0.5rem 0.75rem;
  font: inherit;
  font-size: 1.25rem;
  letter-spacing: 0.2em;
  color: inherit;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 0.375rem;
}
button {
  padding: 0.6rem 1.25rem;
  font: inherit;
  font-weight: 600;
  color: var(--accent-fg);
  background: var(--accent);
  border: 0;
  border-radius: 0.375rem;
  cursor: pointer;
}
input:focus, button:focus, audio:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
a { color: var(--accent); }
.loading { display: flex; align-items: center; gap: 0.75rem; font-weight: 600; }
.spinner {
  flex: none;
  width: 1.25rem;
  height: 1.25rem;
  border: 3px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: captcha-spin 0.8s linear infinite;
}
@keyframes captcha-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
${CAPTCHA_CSS}`;

/** Changes whenever the CSS does, so the stylesheet URL can be cached forever. */
export const CSS_VERSION = createHash('sha256').update(PAGE_CSS).digest('hex').slice(0, 12);

export interface PageText {
  title: string;
  intro: string;
  lang: string;
}

export function gatePage(
  c: Challenge,
  opts: PageText & { prefix: string; next: string; error?: string; method: 'post' | 'get' },
): string {
  return `<!DOCTYPE html>
<html lang="${esc(opts.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(opts.title)}</title>
<link rel="stylesheet" href="${esc(`${opts.prefix}/style.css?v=${CSS_VERSION}`)}">
</head>
<body>
<main>
<h1>${esc(opts.title)}</h1>
<p class="intro">${esc(opts.intro)}</p>
${opts.error ? `<p role="alert">${esc(opts.error)}</p>\n` : ''}<form method="${opts.method}" action="${esc(`${opts.prefix}/verify`)}">
${renderFields(c, { audioUrl: `${opts.prefix}/audio.wav` })}
<input type="hidden" name="next" value="${esc(opts.next)}">
<button type="submit">Continue</button>
</form>
</main>
</body>
</html>
`;
}

/**
 * Shown between a solved challenge and the page the visitor asked for.
 *
 * A plain redirect would leave the solved challenge on screen until the app
 * answers, which for a slow app looks as if the answer did nothing. This page
 * comes back at once, and its meta refresh then fetches the destination while
 * the "Loading" message stays on screen. A meta refresh needs no script, so it
 * works under `script-src 'none'`, and no CSP directive governs it. The link
 * covers a browser with refresh turned off.
 */
export function forwardPage(opts: PageText & { prefix: string; next: string }): string {
  // The refresh URL is quoted, so a ' inside it would end it early.
  const refresh = `0; url='${opts.next.replace(/'/g, '%27')}'`;
  return `<!DOCTYPE html>
<html lang="${esc(opts.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="${esc(refresh)}">
<title>${esc(opts.title)}</title>
<link rel="stylesheet" href="${esc(`${opts.prefix}/style.css?v=${CSS_VERSION}`)}">
</head>
<body>
<main>
<h1>${esc(opts.title)}</h1>
<p class="loading" role="status"><span class="spinner" aria-hidden="true"></span>Welcome. Loading…</p>
<p class="intro"><a href="${esc(opts.next)}">Continue</a> if it doesn't open by itself.</p>
</main>
</body>
</html>
`;
}

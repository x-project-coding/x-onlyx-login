/**
 * A record of what the sign-in view was actually allowed to do — OFF unless asked for.
 *
 * WHY THIS EXISTS. The sign-in view is deliberately locked down: popups denied, non-https
 * navigation blocked, downloads refused, every permission but three denied, WebAuthn neutralised.
 * Each of those guards fails SILENTLY — `event.preventDefault()` tells the page nothing, a denied
 * `window.open` returns `null`, a refused permission is indistinguishable from the creator clicking
 * Block. When OnlyFans handed the operator an identity check on 2026-09-02 and the phone that
 * scanned its QR was answered `Error.Header.NotFound` — raw i18n keys, so the vendor could not even
 * name the state it was in — the app had logged NOTHING about any of it. One screenshot, no
 * evidence, and no way to tell a guard of ours from a vendor outage.
 *
 * So: an opt-in recorder that writes one JSON line per event to a local file. The operator
 * reproduces once with it on and hands over the file.
 *
 * WHAT IT MUST NEVER DO:
 *   - be on by default. The app's promise is that nothing of a run outlives the run; this
 *     deliberately breaks that, so it is only ever switched on by hand, for one reproduction.
 *   - write a secret. URLs keep their origin and path and the NAMES of their query parameters —
 *     never a value. Console text has long token-shaped runs masked. Cookies, the pass token, the
 *     claim and anything the creator types are never passed to it in the first place.
 *   - break the app. Every call is swallowed; a recorder that cannot write is a recorder that
 *     records nothing, not a sign-in that fails.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Anything longer than this is a payload, not a diagnostic. */
const MAX_TEXT = 400;
const MAX_URL = 300;

/**
 * A token-shaped run: at least 24 characters of the alphabet secrets are written in, carrying at
 * least two digits. The digit rule is what keeps ordinary long identifiers readable —
 * `isUserVerifyingPlatformAuthenticatorAvailable` is 44 characters and must survive, or the console
 * errors this file exists to capture arrive unreadable.
 */
const TOKENISH = /[A-Za-z0-9_-]{24,}/g;
const hasTwoDigits = (s) => (s.match(/\d/g) ?? []).length >= 2;

/** Mask token-shaped runs and cap the length. Best effort — never a licence to log a known secret. */
export const redactText = (text, { max = MAX_TEXT } = {}) => {
  if (typeof text !== 'string') return '';
  const masked = text.replace(TOKENISH, (run) => (hasTwoDigits(run) ? `<redacted:${run.length}>` : run));
  return masked.length > max ? `${masked.slice(0, max)}…(+${masked.length - max})` : masked;
};

/**
 * A URL with its secrets taken out: origin and path in full (that is the whole diagnostic value),
 * query parameter NAMES only, fragment reduced to the fact that there was one. A verification
 * handoff carries its session in exactly those two places, so neither may be written down.
 */
export const redactUrl = (url) => {
  if (typeof url !== 'string' || !url) return '<none>';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Not absolute (a relative target, or something Chromium has not resolved yet).
    return redactText(url.split(/[?#]/)[0], { max: MAX_URL });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    // about:, blob:, data:, javascript:, a custom scheme — the SCHEME is the diagnostic; the body
    // of a data: or javascript: URL is content and never wanted.
    const opaque = ['data:', 'javascript:', 'blob:'].includes(parsed.protocol);
    return opaque ? `${parsed.protocol}<${url.length} chars>` : redactText(url.split('#')[0], { max: MAX_URL });
  }
  const names = [...parsed.searchParams.keys()];
  const query = names.length ? ` ?${names.join(',')}` : '';
  const frag = parsed.hash ? ` #<${parsed.hash.length - 1} chars>` : '';
  const out = `${parsed.origin}${parsed.pathname}${query}${frag}`;
  return out.length > MAX_URL ? `${out.slice(0, MAX_URL)}…` : out;
};

const stamp = (date) => date.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');

/**
 * Where the record goes, or null for off — which is every run nobody asked.
 *
 * `ONLYX_LOGIN_DIAG` unset, empty, `0`, `false` or `off` → off. A value containing a path separator
 * is that exact file (what the end-to-end test pins); any other truthy value means "somewhere I can
 * find it", which is the app's own log directory.
 *
 * The env var is the explicit gate the operator turns, so it is honoured in a packaged build too —
 * a packaged app that could only ever be debugged by rebuilding it is a packaged app nobody debugs.
 * `packaged` is passed in so a future policy can narrow it without changing the callers.
 */
export const diagnosticTarget = ({ env = {}, logDir = '.', now = () => new Date(), packaged = false } = {}) => {
  const raw = env.ONLYX_LOGIN_DIAG;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  if (['0', 'false', 'off', 'no'].includes(value.toLowerCase())) return null;
  if (value.includes('/') || value.includes('\\')) return value;
  return path.join(logDir, `onlyx-login-signin-${stamp(now())}${packaged ? '' : '-dev'}.log`);
};

/**
 * Whether the sign-in view may open a real popup window for a vendor handoff.
 *
 * OFF by default — today's behaviour (deny, and load an https target in the same view) is what
 * v1.1.0 shipped, and it is not being changed on a hypothesis. `ONLYX_LOGIN_POPUPS=allow` turns on
 * the scoped popup so a single reproduction can test whether the handoff needs one; see the handler
 * in main.js for what the popup is and is not allowed to be.
 */
export const popupsAllowed = ({ env = {} } = {}) => {
  const raw = env.ONLYX_LOGIN_POPUPS;
  return typeof raw === 'string' && ['allow', 'on', '1', 'true'].includes(raw.trim().toLowerCase());
};

/**
 * The recorder. `append` is injectable so the unit tests can read what would be written without a
 * disk, and so a failing disk is a swallowed no-op rather than a thrown sign-in.
 */
export const openRecorder = ({ file, meta = {}, now = () => new Date(), append = fs.appendFileSync } = {}) => {
  if (!file) return null;
  let dead = false;
  const write = (obj) => {
    if (dead) return;
    try {
      append(file, `${JSON.stringify(obj)}\n`);
    } catch {
      // One failure is enough: a recorder that cannot write must not try on every navigation.
      dead = true;
    }
  };
  write({ t: now().toISOString(), kind: 'diagnostic-start', ...meta });
  return {
    file,
    get disabled() {
      return dead;
    },
    record(kind, fields = {}) {
      write({ t: now().toISOString(), kind, ...fields });
    },
  };
};

/**
 * The passive half: everything a webContents will tell us without being asked. The decisions the
 * app itself makes — a denied popup, a blocked navigation, a refused permission — are recorded at
 * the point they are made, in main.js, because only there is the verdict known.
 *
 * Returns a detach function. Nothing here can throw into the app: the listeners are wrapped, and
 * an Electron version that does not emit one of these events simply records nothing for it.
 */
export const attachContentsDiagnostics = (contents, recorder, { tag = 'signin' } = {}) => {
  if (!recorder || !contents) return () => {};
  const listeners = [];
  const on = (event, handler) => {
    const wrapped = (...args) => {
      try {
        handler(...args);
      } catch {
        /* a diagnostic must never break the view it is watching */
      }
    };
    try {
      contents.on(event, wrapped);
      listeners.push([event, wrapped]);
    } catch {
      /* an event this Electron does not have */
    }
  };
  const rec = (kind, fields) => recorder.record(kind, { view: tag, ...fields });

  // Electron 44 passes a details object first and keeps the old positional arguments after it,
  // deprecated. Read the object when it is there and fall back to the positional url, so this
  // survives the removal of either shape.
  const urlOf = (details, positional) =>
    typeof details?.url === 'string' ? details.url : typeof positional === 'string' ? positional : '';

  on('will-navigate', (details, url) => rec('will-navigate', { url: redactUrl(urlOf(details, url)) }));
  on('will-redirect', (details, url) => rec('will-redirect', { url: redactUrl(urlOf(details, url)) }));
  on('will-frame-navigate', (details) =>
    rec('will-frame-navigate', { url: redactUrl(details?.url), mainFrame: Boolean(details?.isMainFrame) }));
  on('did-navigate', (_event, url, code) => rec('did-navigate', { url: redactUrl(url), httpStatus: code ?? null }));
  on('did-navigate-in-page', (_event, url, isMainFrame) =>
    rec('did-navigate-in-page', { url: redactUrl(url), mainFrame: Boolean(isMainFrame) }));
  on('did-frame-navigate', (_event, url, code, _text, isMainFrame) =>
    rec('did-frame-navigate', { url: redactUrl(url), httpStatus: code ?? null, mainFrame: Boolean(isMainFrame) }));
  on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) =>
    rec('did-fail-load', {
      errorCode: errorCode ?? null,
      error: redactText(String(errorDescription ?? ''), { max: 120 }),
      url: redactUrl(validatedURL),
      mainFrame: Boolean(isMainFrame),
    }));
  on('console-message', (details, level, message, line, sourceId) => {
    const text = typeof details?.message === 'string' ? details.message : String(message ?? '');
    const severity = typeof details?.level === 'string' ? details.level : String(level ?? '');
    // Only what could name a failure. `info`/`debug` chatter from a live site is thousands of lines
    // and would bury the four that matter.
    if (severity !== 'error' && severity !== 'warning' && severity !== '2' && severity !== '3') return;
    rec('console', {
      level: severity,
      text: redactText(text),
      source: redactUrl(typeof details?.sourceId === 'string' ? details.sourceId : sourceId),
      line: details?.lineNumber ?? line ?? null,
    });
  });
  on('render-process-gone', (_event, details) => rec('render-process-gone', { reason: details?.reason ?? null }));
  on('unresponsive', () => rec('unresponsive', {}));
  on('did-create-window', (_window, details) => rec('did-create-window', { url: redactUrl(details?.url) }));

  return () => {
    for (const [event, handler] of listeners) {
      try {
        contents.off(event, handler);
      } catch {
        /* the contents are already gone */
      }
    }
    listeners.length = 0;
  };
};

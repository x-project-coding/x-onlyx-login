/**
 * What "signed in" means, and what gets handed back — the same rules the seat uses, so the jar the
 * app captures is one the seat can resume (worker/runtime/src/session.js in x-onlyfans).
 *
 * Signed in = OnlyFans itself said so: a 200 from `/api2/v2/users/me` naming an `id`, AND the two
 * cookies that carry a login (`sess`, `auth_id`) present in the jar at that moment. A cookie alone
 * is not enough (it can be present and dead); a `/users/me` alone is not enough (it can be the
 * guest answer, which is a 200 with no `id`).
 */

/** Cookies the seat never restores; captured here would only be dropped there. */
const NEVER = new Set(['__cf_bm', '_cfuvid']);
export const ME_PATH = '/api2/v2/users/me';

export const isMeUrl = (url) => {
  try {
    const u = new URL(url);
    return /(^|\.)onlyfans\.com$/i.test(u.hostname) && u.pathname === ME_PATH;
  } catch {
    return false;
  }
};

/** `id` and `username` from a `/users/me` body, or null for a guest answer or anything unparseable. */
export const judgeMe = (body) => {
  let me = body;
  if (typeof body === 'string') {
    try {
      me = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!me || typeof me !== 'object' || !me.id) return null;
  return { id: String(me.id), username: typeof me.username === 'string' ? me.username : null };
};

const onOnlyFans = (cookie) => typeof cookie?.domain === 'string' && cookie.domain.includes('onlyfans.com');

export const hasLoginCookies = (cookies) => {
  const named = new Set(
    (cookies ?? []).filter((c) => onOnlyFans(c) && typeof c.value === 'string' && c.value.length > 0).map((c) => c.name),
  );
  return named.has('sess') && named.has('auth_id');
};

/**
 * One cookie in the store's shape, from either Electron's `session.cookies.get` shape
 * (`expirationDate`, `session`) or CDP's (`expires`). A session cookie carries `expires: -1`, which
 * is what the seat's own captures carry for one.
 */
const normalizeCookie = (c) => {
  const out = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: typeof c.path === 'string' && c.path ? c.path : '/',
  };
  if (c.session === true) out.expires = -1;
  else if (typeof c.expirationDate === 'number') out.expires = c.expirationDate;
  else if (typeof c.expires === 'number') out.expires = c.expires;
  if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
  if (typeof c.secure === 'boolean') out.secure = c.secure;
  return out;
};

/** The import body for POST /connect-app/session. `xbc` is `{ key, value }` or null. */
export const buildSessionPayload = (cookies, xbc, { now = () => new Date() } = {}) => {
  const kept = (cookies ?? [])
    .filter(
      (c) =>
        onOnlyFans(c) &&
        !NEVER.has(c.name) &&
        typeof c.name === 'string' &&
        c.name.length > 0 &&
        typeof c.value === 'string' &&
        c.value.length > 0,
    )
    .map(normalizeCookie);
  return {
    cookies: kept,
    cookieHeader: kept.map((c) => `${c.name}=${c.value}`).join('; '),
    xbc: xbc?.value ?? null,
    xbcKey: xbc?.key ?? null,
    capturedAt: now().toISOString(),
  };
};

/**
 * The in-page expression that finds the device token, verbatim from the seat: any local-storage key
 * naming `bc` whose value is 40 hex characters. Evaluated over CDP so the page's own scripts see
 * nothing of it.
 */
export const READ_XBC_EXPRESSION = `(() => {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.toLowerCase().includes('bc')) {
        const value = localStorage.getItem(key);
        if (value && /^[0-9a-f]{40}$/i.test(value)) return JSON.stringify({ key, value });
      }
    }
  } catch (e) {}
  return null;
})()`;

/**
 * The seat's hardening, applied here for the same reasons: OnlyFans probes WebAuthn on the login
 * form, and a passkey prompt is a dead end for a session the seat has to resume without one.
 */
export const HARDEN_SCRIPT = `
  try {
    if (navigator.credentials) {
      navigator.credentials.get = () => Promise.reject(new DOMException('Not supported', 'NotAllowedError'));
      navigator.credentials.create = () => Promise.reject(new DOMException('Not supported', 'NotAllowedError'));
    }
    if (window.PublicKeyCredential) {
      window.PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
      window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
    }
  } catch (e) { /* older engine — nothing to neutralise */ }
`;

/**
 * The three calls the app makes, and the one thing it holds: the pass's session token.
 *
 *   open(claim)                spend the link; get the identity to present, the tunnel, the token
 *   importSession(payload)     hand over the signed-in jar
 *   status()                   what the seat made of it
 *
 * Every failure is an `ApiError` carrying the server's `error` code, so the UI maps codes to words
 * for the creator in one place (messages.js) and the transport stays free of prose.
 */

export class ApiError extends Error {
  constructor(status, code, detail = null) {
    super(`api ${status} ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const TIMEOUT_MS = 20_000;

export class OnlyxApi {
  #base;
  #fetch;
  #meta;

  constructor(base, { fetch = globalThis.fetch, appVersion = null, platform = null } = {}) {
    this.#base = base.replace(/\/+$/, '');
    this.#fetch = fetch;
    this.#meta = { appVersion, platform };
  }

  get base() {
    return this.#base;
  }

  async #call(method, path, { token = null, body = undefined } = {}) {
    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ApiError(0, err?.name === 'AbortError' ? 'timeout' : 'unreachable', String(err?.message ?? err));
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw new ApiError(res.status, json?.error ?? `http_${res.status}`, json);
    return json;
  }

  /** Spend a claim. Returns the opened pass: token, expiry, account, identity, tunnel. */
  open(claim) {
    return this.#call('POST', '/connect-app/open', { body: { claim, ...this.#meta } });
  }

  importSession(token, payload) {
    return this.#call('POST', '/connect-app/session', { token, body: payload });
  }

  status(token) {
    return this.#call('GET', '/connect-app/status', { token });
  }
}

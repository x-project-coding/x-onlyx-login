/**
 * The three servers a real OnlyX Login run talks to, faked in-process so the whole flow — open a
 * pass, tunnel a TLS connection through, sign in, capture, import, poll to connected — can be driven
 * end to end against the real, packaged-shaped app.
 *
 *   fake API      /connect-app/open | /session | /status   (http)
 *   fake tunnel   a WS that dials the fake OnlyFans and pipes bytes   (ws)
 *   fake OnlyFans a login page + /api2/v2/users/me that flips to signed-in   (https, self-signed)
 *
 * The tunnel ignores the CONNECT target and always dials the fake OnlyFans: the app asks for
 * onlyfans.com:443, and this stands in for it. TLS runs end to end between the app's sign-in browser
 * and the fake site; the app trusts the self-signed cert only because the test passes its
 * fingerprint in ONLYX_TEST_CERT_SHA256.
 *
 * The fake API can also answer with `tunnel: null` (tunnelPort: null) — the production-default
 * "sign in over your own network" shape. There is then no tunnel to redirect the browser, so that
 * test pins onlyfans.com to the fake with Chromium's --host-resolver-rules instead (no-tunnel.test.js).
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { WebSocketServer } from 'ws';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * The login page: on load it "signs in" by itself, then asks who it is — exactly what the app
 * watches for — and POSTs what the browser says about itself to `/probe`.
 *
 * The probe is not decoration. What identity the app applied is only observable from inside a page
 * it navigated, and the two halves live in different places: the wire (recorded from the request
 * headers below) and the page (recorded here). A test that checked only one would pass on an
 * identity that contradicted itself, which is the exact defect this whole area exists to remove.
 */
const LOGIN_PAGE = `<!doctype html><html><head><meta charset=utf-8><title>OnlyFans</title></head>
<body><h1>Log in</h1><p id=s>working…</p>
<script>
(async () => {
  const me1 = await fetch('/api2/v2/users/me', { credentials: 'include' });   // guest: 401
  document.getElementById('s').textContent = 'guest ' + me1.status;
  await fetch('/login', { method: 'POST', credentials: 'include' });          // sets sess + auth_id
  try { localStorage.setItem('ofBcToken', '0123456789abcdef0123456789abcdef01234567'); } catch (e) {}
  const me2 = await fetch('/api2/v2/users/me', { credentials: 'include' });   // now 200 with an id
  document.getElementById('s').textContent = 'me ' + me2.status;
  try {
    let gl = null;
    const ctx = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    if (ctx) {
      // BEFORE the extension is obtained, which is the reading that separates a real Chrome (null)
      // from a patched getParameter (a string).
      gl = { vendorUnasked: ctx.getParameter(37445), rendererUnasked: ctx.getParameter(37446) };
      gl.getParameterSource = Function.prototype.toString.call(ctx.getParameter);
    }
    // 'engine' or 'patched'. The property IS an own accessor of Navigator.prototype in a real
    // browser too — measured — so its PRESENCE proves nothing; only the getter's source separates
    // the engine's from a pin's, and it does so without depending on this machine's real numbers.
    const own = (name) => {
      const d = Object.getOwnPropertyDescriptor(Navigator.prototype, name);
      if (!d || !d.get) return 'absent';
      return /\[native code\]/.test(Function.prototype.toString.call(d.get)) ? 'engine' : 'patched';
    };
    let high = null;
    try { high = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'fullVersionList', 'uaFullVersion', 'architecture']) : null; } catch (e) {}
    await fetch('/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        languages: navigator.languages,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory === undefined ? null : navigator.deviceMemory,
        // "engine" or "redefined": the pins define these ON Navigator.prototype, so this says
        // whether they were applied without depending on what this machine's real numbers are.
        descriptors: { hardwareConcurrency: own('hardwareConcurrency'), deviceMemory: own('deviceMemory'), platform: own('platform') },
        brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
        uadPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
        high,
        webgl: gl,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
  } catch (e) {}
})();
</script></body></html>`;

export const startFakeOnlyFans = async ({ key, cert, userId = '778899', username = 'creatorx', pages = {} }) => {
  const state = { loggedIn: false, meHits: 0, requests: [], probe: null };
  const server = https.createServer({ key, cert }, async (req, res) => {
    const url = new URL(req.url, 'https://onlyfans.com');
    // ONE read of the body, here, for every POST. The `/probe` route below must NOT read the
    // stream again: by the time it runs this await has already consumed it, and a second
    // `req.on('data')` would resolve empty and hang the probe for ever.
    let body = '';
    if (req.method === 'POST') {
      body = await new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => (b += c));
        req.on('end', () => resolve(b));
      });
    }
    state.requests.push({
      method: req.method,
      path: url.pathname,
      url: req.url,
      referer: req.headers.referer ?? null,
      cookie: req.headers.cookie ?? null,
      contentType: req.headers['content-type'] ?? null,
      // THE WHOLE HEADER BAG as well as the named fields above. The vendor-handoff tests read the
      // named ones (what the in-place load SENT); the identity tests read `user-agent` and
      // `sec-ch-ua-*` (what browser it claimed to be). One array, both questions.
      headers: req.headers,
      body,
    });
    // Ask for the high-entropy hints, so the SECOND request onwards may carry them. Merged with
    // whatever `writeHead` sets below, since headers set here are not replaced by it.
    res.setHeader(
      'accept-ch',
      'sec-ch-ua-platform-version, sec-ch-ua-arch, sec-ch-ua-full-version-list, sec-ch-ua-model, sec-ch-ua-bitness',
    );
    if (url.pathname === '/probe' && req.method === 'POST') {
      try {
        state.probe = JSON.parse(body);
      } catch {
        state.probe = { unparseable: body.slice(0, 200) };
      }
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      state.loggedIn = true;
      res.setHeader('set-cookie', [
        `sess=SESSIONVALUE${Date.now()}; Path=/; HttpOnly; Secure; SameSite=None`,
        `auth_id=${userId}; Path=/; HttpOnly; Secure; SameSite=None`,
      ]);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/api2/v2/users/me') {
      state.meHits += 1;
      if (!state.loggedIn) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"error":{"code":401}}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: userId, username, name: 'Creator X' }));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pages[url.pathname] ?? LOGIN_PAGE);
  });
  const port = await listen(server);
  return { port, state, close: () => new Promise((r) => server.close(r)) };
};

/** The sign-in page itself, for a test that wants to reach it by an unusual route. */
export const SIGN_IN_PAGE = LOGIN_PAGE;

export const startFakeTunnel = async ({ onlyfansPort, expectToken }) => {
  const seen = { upgrades: 0, tokens: [] };
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    seen.upgrades += 1;
    seen.tokens.push(req.headers.authorization);
    if (expectToken && req.headers.authorization !== `Bearer ${expectToken}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const upstream = net.connect(onlyfansPort, '127.0.0.1', () => {
        ws.send(JSON.stringify({ t: 'ready' }));
      });
      upstream.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d, { binary: true }); });
      ws.on('message', (d, isBinary) => { if (isBinary) upstream.write(d); });
      const shut = () => { try { upstream.destroy(); } catch {} try { ws.close(); } catch {} };
      upstream.on('close', shut); upstream.on('error', shut);
      ws.on('close', shut); ws.on('error', shut);
    });
  });
  const port = await listen(server);
  return { port, seen, close: () => new Promise((r) => server.close(r)) };
};

/**
 * `tunnelPort: null` answers the open with `tunnel: null` — the server's "sign in over your own
 * network" shape (XOF_CONNECT_APP_TUNNEL off, the production default). A port keeps the old shape.
 */
/**
 * `identity` overrides the served identity field-by-field, so one test can drive the SEAT shape and
 * the next the NATIVE one against the same app. The default is the seat shape this app was born
 * wearing.
 */
export const startFakeApi = async ({ tunnelPort = null, userAgent, claim, connectAfter = 2, identity = {} }) => {
  const token = `sess-token-${Math.random().toString(36).slice(2)}`;
  // `connectedFrom` is the poll number at which this fake FIRST answered `connected`. The app
  // must not have shown its success screen before it — see the gate assertions in app.test.js.
  const record = { open: 0, imports: [], statusHits: 0, connectedFrom: null };
  const readBody = (req) =>
    new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => resolve(b ? JSON.parse(b) : {}));
    });
  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://api');
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (url.pathname === '/connect-app/open' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.claim !== claim) return json(res, 404, { error: 'invalid_or_spent' });
      record.open += 1;
      return json(res, 200, {
        sessionToken: token,
        expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
        account: { id: 'acct_1', username: 'creatorx', status: 'connecting' },
        identity: {
          profile: 'mac',
          source: 'seat',
          userAgent,
          acceptLanguage: 'en-US,en;q=0.9',
          platform: 'MacIntel',
          // The seat's pins, as x-onlyfans' identityScript renders them: the platform, the core
          // count, the memory size and the patched renderer lookup.
          initScript:
            "try{Object.defineProperty(Navigator.prototype,'platform',{get:()=>'MacIntel',enumerable:true,configurable:true});}catch(e){}" +
            " try{Object.defineProperty(Navigator.prototype,'hardwareConcurrency',{get:()=>8,enumerable:true,configurable:true});}catch(e){}" +
            " try{Object.defineProperty(Navigator.prototype,'deviceMemory',{get:()=>8,enumerable:true,configurable:true});}catch(e){}" +
            " try{(function(){var V='Google Inc. (Apple)',R='ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)';" +
            "[window.WebGLRenderingContext,window.WebGL2RenderingContext].forEach(function(C){if(!C||!C.prototype||!C.prototype.getParameter)return;" +
            "var real=C.prototype.getParameter;C.prototype.getParameter=function(p){if(p===37445)return V;if(p===37446)return R;return real.call(this,p);};});})();}catch(e){}",
          timezone: null,
          ...identity,
        },
        tunnel: tunnelPort ? { url: `ws://127.0.0.1:${tunnelPort}/connect-app/tunnel` } : null,
      });
    }
    if (url.pathname === '/connect-app/session' && req.method === 'POST') {
      if (bearer !== token) return json(res, 401, { error: 'pass_invalid' });
      const body = await readBody(req);
      record.imports.push(body);
      return json(res, 200, { ok: true, importedAt: new Date().toISOString(), seat: { workerId: 'w1', seatIndex: 0 } });
    }
    if (url.pathname === '/connect-app/status' && req.method === 'GET') {
      if (bearer !== token) return json(res, 401, { error: 'pass_invalid' });
      record.statusHits += 1;
      const connected = record.imports.length > 0 && record.statusHits >= connectAfter;
      if (connected && record.connectedFrom === null) record.connectedFrom = record.statusHits;
      return json(res, 200, {
        state: connected ? 'connected' : record.imports.length ? 'verifying' : 'awaiting_session',
        username: 'creatorx',
        accountStatus: connected ? 'connected' : 'connecting',
        statusReason: null,
        importedAt: record.imports[0] ? new Date().toISOString() : null,
        expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
      });
    }
    json(res, 404, { error: 'not_found' });
  });
  const port = await listen(server);
  return { port, token, record, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
};

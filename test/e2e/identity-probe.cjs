// MEASURES what each half of the served `identity` actually does to the sign-in browser, so the
// decision about which halves to keep is taken from readings rather than from the schema.
//
// ONE SCENARIO PER PROCESS (`ONLYX_IDENTITY_SCENARIO`), because a second BrowserWindow with a
// second attached debugger in the same process SIGTRAPs under Xvfb — measured, 2026-09-02. The
// runner loops; this file measures.
//
// It applies the identity exactly as src/identity.js does — `session.setUserAgent`, then
// `Network.setUserAgentOverride`, then the init script, over the view's own debugger, after the
// same about:blank warm-up main.js does — loads a page from a local server, and records BOTH sides:
//
//   the wire   user-agent, sec-ch-ua, sec-ch-ua-platform, sec-ch-ua-platform-version, ...
//   the page   navigator.userAgent / platform / hardwareConcurrency / deviceMemory,
//              navigator.userAgentData (+ high entropy), WebGL 37445/37446
//
// Writes one JSON object to ONLYX_IDENTITY_REPORT. A test fixture, never shipped.
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');

// The seat pins its renderer for the same reason; without it this container blocklists WebGL and
// the two renderer readings come back null, which would look like a finding and is not.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

const report = process.env.ONLYX_IDENTITY_REPORT;
const wanted = process.env.ONLYX_IDENTITY_SCENARIO;

const MAC_UA_151 =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const SEAT_METADATA = {
  brands: [
    { brand: 'Chromium', version: '151' },
    { brand: 'Google Chrome', version: '151' },
    { brand: 'Not_A Brand', version: '24' },
  ],
  fullVersion: '151.0.7922.173',
  platform: 'macOS',
  platformVersion: '14.6.0',
  architecture: 'arm',
  model: '',
  mobile: false,
  bitness: '64',
  wow64: false,
};
// device-profile.js's mac `pin`, rendered exactly as page-identity.js's identityScript renders it.
const SEAT_INIT_SCRIPT = [
  `try { Object.defineProperty(Navigator.prototype, 'platform', { get: () => "MacIntel", enumerable: true, configurable: true }); } catch (e) {}`,
  `try { Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8, enumerable: true, configurable: true }); } catch (e) {}`,
  `try { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8, enumerable: true, configurable: true }); } catch (e) {}`,
  `try { (() => { const V = "Google Inc. (Apple)", R = "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)"; for (const Ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) { if (!Ctx || !Ctx.prototype || !Ctx.prototype.getParameter) continue; const real = Ctx.prototype.getParameter; Ctx.prototype.getParameter = function (p) { if (V && p === 37445) return V; if (R && p === 37446) return R; return real.call(this, p); }; try { Object.defineProperty(Ctx.prototype.getParameter, 'name', { value: 'getParameter', configurable: true }); } catch (e) {} } })(); } catch (e) {}`,
].join(' ');

/** Everything the page can say about itself, read after load. */
const MEASURE = `(async () => {
  const nav = navigator;
  let gl = null;
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('webgl2') || c.getContext('webgl');
    if (ctx) {
      // BOTH readings, because they are different questions. Real Chrome answers 37445/37446 with
      // null until WEBGL_debug_renderer_info has been obtained; a patched getParameter answers
      // either way, which is a difference a fingerprinter can see without asking about the GPU.
      const before = { vendor: ctx.getParameter(37445), renderer: ctx.getParameter(37446) };
      const ext = ctx.getExtension('WEBGL_debug_renderer_info');
      gl = {
        withoutExtension: before,
        extension: ext ? { UNMASKED_VENDOR_WEBGL: ext.UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL: ext.UNMASKED_RENDERER_WEBGL } : null,
        withExtension: { vendor: ctx.getParameter(37445), renderer: ctx.getParameter(37446) },
        plainVendor: ctx.getParameter(ctx.VENDOR),
        plainRenderer: ctx.getParameter(ctx.RENDERER),
        getParameterName: ctx.getParameter.name,
        getParameterSource: Function.prototype.toString.call(ctx.getParameter).slice(0, 70),
      };
    } else { gl = { error: 'no context' }; }
  } catch (e) { gl = { error: String(e && e.message || e) }; }
  let uad = null;
  if (nav.userAgentData) {
    uad = { brands: nav.userAgentData.brands, mobile: nav.userAgentData.mobile, platform: nav.userAgentData.platform };
    try {
      uad.high = await nav.userAgentData.getHighEntropyValues([
        'architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion', 'fullVersionList', 'wow64',
      ]);
    } catch (e) { uad.high = { error: String(e && e.message || e) }; }
  }
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory === undefined ? null : nav.deviceMemory,
    maxTouchPoints: nav.maxTouchPoints,
    languages: nav.languages,
    userAgentData: uad,
    webgl: gl,
  };
})()`;

const SCENARIOS = {
  // What the app does today: the seat's UA, the seat's client hints, the seat's pins.
  'seat-full': { userAgent: MAC_UA_151, platform: 'MacIntel', metadata: SEAT_METADATA, initScript: SEAT_INIT_SCRIPT },
  // Same wire, no pins — does dropping the init script really restore the machine's own answers?
  'seat-ua-no-pins': { userAgent: MAC_UA_151, platform: 'MacIntel', metadata: SEAT_METADATA, initScript: null },
  // The half-way state a naive "just drop the pins" server would make: a UA claiming 151 over the
  // engine's OWN client hints.
  'seat-ua-no-metadata': { userAgent: MAC_UA_151, platform: null, metadata: null, initScript: null },
  // Nothing applied at all: what this Electron is, untouched. `userAgent: null` = skip the calls.
  'native-untouched': { userAgent: null, platform: null, metadata: null, initScript: null },
  // What an OLD (v1.1.0) app does if the server sends an EMPTY user agent: it cannot skip the call.
  'empty-string-ua': { userAgent: '', platform: null, metadata: null, initScript: null, forceOverride: true },
  // ... or a missing one. `identity.userAgent` is read with no guard in v1.1.0.
  'undefined-ua': { userAgent: undefined, platform: null, metadata: null, initScript: null, forceOverride: true },
  // The shape this lane ships: the machine's OWN engine, with the Electron/app tokens stripped, and
  // client hints rebuilt from the real engine so the wire and the page agree.
  'native-cleaned': { cleaned: true, initScript: null },
  // The same, but with the client hints built from the REAL platform and NO acceptLanguage
  // override — the end state the app is meant to reach.
  'native-honest': { cleaned: true, honestPlatform: true, noAcceptLanguage: true, initScript: null },
  // Today's seat identity with the language override REMOVED, to isolate what that argument does.
  'seat-no-lang': { userAgent: MAC_UA_151, platform: 'MacIntel', metadata: SEAT_METADATA, initScript: null, noAcceptLanguage: true },
};

const step = (m) => { try { process.stderr.write(`[probe] ${m}\n`); } catch (e) {} };
const wireHeaders = [];

const start = async () => {
  const s = SCENARIOS[wanted];
  if (!s) throw new Error(`unknown scenario ${wanted}`);
  step(`scenario ${wanted}`);

  const server = http.createServer((req, res) => {
    wireHeaders.push({ url: req.url, headers: req.headers });
    res.writeHead(200, {
      'content-type': 'text/html',
      'accept-ch': 'sec-ch-ua-platform-version, sec-ch-ua-arch, sec-ch-ua-full-version-list, sec-ch-ua-model, sec-ch-ua-bitness',
    });
    res.end('<!doctype html><title>probe</title><body>probe</body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const rec = { name: wanted, errors: [], electron: process.versions.electron, chrome: process.versions.chrome };
  const ses = session.fromPartition(`probe-${wanted}-${Date.now()}`);
  rec.sessionUserAgentDefault = ses.getUserAgent();

  // The cleaned scenario builds its identity from THIS engine rather than from anything served.
  let userAgent = s.userAgent;
  let metadata = s.metadata ?? null;
  let platform = s.platform ?? null;
  let apply = s.userAgent !== null || s.forceOverride === true;
  if (s.cleaned) {
    const chrome = process.versions.chrome;
    const major = chrome.split('.')[0];
    userAgent = ses
      .getUserAgent()
      .replace(/\s*[A-Za-z0-9._-]+\/\d[\d.]*\s*(?=Chrome\/)/, ' ') // the app's own product token
      .replace(/\s*Electron\/\d[\d.]*/, '');
    metadata = {
      brands: [
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
        { brand: 'Not_A Brand', version: '24' },
      ],
      // BOTH, because they are not the same field. `fullVersion` is the deprecated one the seat
      // profile sets; `fullVersionList` is what `Sec-CH-UA-Full-Version-List` and
      // `getHighEntropyValues` read, and it falls back to the REAL engine when unset.
      fullVersion: chrome,
      fullVersionList: [
        { brand: 'Chromium', version: chrome },
        { brand: 'Google Chrome', version: chrome },
        { brand: 'Not_A Brand', version: '24.0.0.0' },
      ],
      ...(s.honestPlatform
        ? { platform: 'Linux', platformVersion: '', architecture: 'x86', bitness: '64' }
        : { platform: 'macOS', platformVersion: '14.6.0', architecture: 'arm', bitness: '64' }),
      model: '',
      mobile: false,
      wow64: false,
    };
    apply = true;
  }

  if (apply) {
    try {
      if (s.noAcceptLanguage) ses.setUserAgent(userAgent);
      else ses.setUserAgent(userAgent, 'en-US,en;q=0.9');
      rec.sessionSetUserAgent = 'ok';
    } catch (err) {
      rec.sessionSetUserAgent = `threw: ${String((err && err.message) || err)}`;
    }
  } else {
    rec.sessionSetUserAgent = 'skipped';
  }
  rec.sessionUserAgentAfter = ses.getUserAgent();

  const win = new BrowserWindow({ width: 900, height: 700, show: true });
  const view = new WebContentsView({
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  const contents = view.webContents;
  const dbg = contents.debugger;
  // The app's own warm-up, for the app's own reason (src/main.js): a WebContentsView has no
  // renderer until it is in a window and something has loaded, and `Page.enable` hangs without one.
  // Measured here first — this probe hung until the line existed.
  await contents.loadURL('about:blank').catch(() => {});

  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
    await dbg.sendCommand('Page.enable');
    await dbg.sendCommand('Network.enable', {});
    if (apply) {
      try {
        await dbg.sendCommand('Network.setUserAgentOverride', {
          userAgent,
          ...(s.noAcceptLanguage ? {} : { acceptLanguage: 'en-US,en;q=0.9' }),
          ...(platform ? { platform } : {}),
          ...(metadata ? { userAgentMetadata: metadata } : {}),
        });
        rec.cdpOverride = 'ok';
      } catch (err) {
        rec.cdpOverride = `threw: ${String((err && err.message) || err)}`;
      }
    } else {
      rec.cdpOverride = 'skipped';
    }
    if (s.initScript) await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: s.initScript });
  } catch (err) {
    rec.errors.push(`setup: ${String((err && err.message) || err)}`);
  }

  step('loading');
  try {
    await contents.loadURL(`http://127.0.0.1:${port}/first`);
    // A second navigation, so the high-entropy hints the server asked for come back on the wire.
    await contents.loadURL(`http://127.0.0.1:${port}/second`);
  } catch (err) {
    rec.errors.push(`load: ${String((err && err.message) || err)}`);
  }
  rec.wire = wireHeaders.map((h) => ({
    url: h.url,
    ua: h.headers['user-agent'] ?? null,
    secChUa: h.headers['sec-ch-ua'] ?? null,
    secChUaPlatform: h.headers['sec-ch-ua-platform'] ?? null,
    secChUaPlatformVersion: h.headers['sec-ch-ua-platform-version'] ?? null,
    secChUaArch: h.headers['sec-ch-ua-arch'] ?? null,
    secChUaFullVersionList: h.headers['sec-ch-ua-full-version-list'] ?? null,
    secChUaMobile: h.headers['sec-ch-ua-mobile'] ?? null,
    acceptLanguage: h.headers['accept-language'] ?? null,
  }));

  step('measuring');
  try {
    rec.page = await contents.executeJavaScript(MEASURE, true);
  } catch (err) {
    rec.errors.push(`measure: ${String((err && err.message) || err)}`);
  }

  if (report) fs.writeFileSync(report, JSON.stringify(rec, null, 2));
  else console.log(JSON.stringify(rec, null, 2));
  server.close();
  step('done');
  // Nothing is torn down by hand: detaching a debugger and destroying a window on the way out is
  // what SIGTRAPped the multi-scenario version. The process is about to end anyway.
  app.exit(0);
};

setTimeout(() => {
  step('HARD TIMEOUT');
  if (report) fs.writeFileSync(report, JSON.stringify({ name: wanted, error: 'timeout' }, null, 2));
  app.exit(2);
}, 60_000);

app.whenReady().then(start).catch((err) => {
  const payload = { name: wanted, error: String((err && err.stack) || err) };
  if (report) fs.writeFileSync(report, JSON.stringify(payload, null, 2));
  else console.log(JSON.stringify(payload, null, 2));
  app.exit(1);
});

/**
 * OnlyX Login — the desktop app a creator opens from a link to sign in to OnlyFans for her
 * OnlyX-managed account.
 *
 * The flow, end to end:
 *
 *   link opened  ->  POST /connect-app/open        the claim becomes a 45-minute pass: an identity
 *                                                  to present, a tunnel to use, a token to hold
 *                ->  loopback forwarder (tunnel.js) every byte of the sign-in browser rides the
 *                                                  account's own proxy, via the OnlyX API
 *                ->  sign-in view                  an in-memory browser wearing the seat's identity
 *                                                  (identity.js); the creator signs in, passes the
 *                                                  selfie check with her own camera
 *                ->  POST /connect-app/session     the jar, the moment OnlyFans names her
 *                ->  GET  /connect-app/status      polled until the seat has adopted the session
 *                ->  success
 *
 * Nothing is persisted: the browser partition is in memory and dropped with the run, the token
 * lives in this process for the pass's lifetime, and no file is written by the app.
 */

import { app, BrowserWindow, WebContentsView, session, ipcMain, Menu, shell, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OnlyxApi } from './api.js';
import { resolveApiBase } from './config.js';
import { SCHEME, claimFromArgv, parseDeepLink } from './deep-link.js';
import { attachIdentity } from './identity.js';
import { messageForFailedConnect, messageForImport, messageForOpen, messageForTunnel } from './messages.js';
import { buildSessionPayload, hasLoginCookies } from './session-capture.js';
import { startForwarder } from './tunnel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HEADER_HEIGHT = 56;
/** How long after OnlyFans names the creator before the jar is read: the sign-in's last cookies land. */
const SETTLE_MS = 2_000;
const STATUS_POLL_MS = 3_000;
const packaged = app.isPackaged;
const log = (...parts) => console.log('[onlyx-login]', ...parts);

/**
 * Test hooks, honoured ONLY in an unpackaged app. `ONLYX_TEST_STATE_FILE` receives one JSON line per
 * state change so an end-to-end test can follow the flow from outside; `ONLYX_TEST_CERT_SHA256`
 * admits exactly one certificate (a test's fake OnlyFans) that the system would refuse.
 */
const testHooks = packaged
  ? null
  : {
      stateFile: process.env.ONLYX_TEST_STATE_FILE || null,
      certSha256: process.env.ONLYX_TEST_CERT_SHA256 || null,
    };

const api = new OnlyxApi(resolveApiBase({ packaged }), {
  appVersion: app.getVersion(),
  platform: `${process.platform}-${process.arch}`,
});

let win = null;
let header = null;
let run = null;
let runSeq = 0;
let pendingClaim = null;
let state = { phase: 'idle' };

const setState = (next) => {
  state = { ...next, at: new Date().toISOString() };
  header?.webContents.send('state', state);
  if (testHooks?.stateFile) {
    try {
      fs.appendFileSync(testHooks.stateFile, `${JSON.stringify(state)}\n`);
    } catch {
      /* a test hook must never break the app */
    }
  }
  layout();
};

const layout = () => {
  if (!win || !header) return;
  const { width, height } = win.getContentBounds();
  if (run?.view && state.phase === 'signin') {
    header.setBounds({ x: 0, y: 0, width, height: HEADER_HEIGHT });
    run.view.setBounds({ x: 0, y: HEADER_HEIGHT, width, height: Math.max(0, height - HEADER_HEIGHT) });
  } else {
    header.setBounds({ x: 0, y: 0, width, height });
    run?.view?.setBounds({ x: 0, y: height, width, height: 0 });
  }
};

const focusWindow = () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
};

// ---------------------------------------------------------------------------------------------
// The run: one opened link, from claim to verdict.
// ---------------------------------------------------------------------------------------------

/**
 * A run that is no longer the current one — or has already finished — must not act.
 *
 * Every `await` in this file is a place a second deep link can arrive: `teardown()` swaps `run` and
 * marks the old one done while the old one is suspended mid-call. Checked after each one, because a
 * resumed stale run would otherwise repaint the screen over the new run and, worse, complete an
 * import against a pass the creator has already walked away from.
 */
const stale = (r) => r !== run || r.done;

const fail = (r, message, err = null) => {
  if (r !== run || r.done) return;
  r.done = true;
  if (err) log(`run ${r.id} failed: ${String(err?.message ?? err).slice(0, 200)}`);
  void closeBrowser(r);
  setState({ phase: 'error', title: message.title, detail: message.detail, username: r.account?.username ?? null });
};

const closeBrowser = async (r) => {
  if (r.pollTimer) clearInterval(r.pollTimer);
  if (r.settleTimer) clearTimeout(r.settleTimer);
  r.pollTimer = null;
  r.settleTimer = null;
  if (r.identity) {
    r.identity.detach();
    r.identity = null;
  }
  if (r.view) {
    const view = r.view;
    r.view = null;
    try {
      win?.contentView.removeChildView(view);
    } catch {
      /* the window is closing */
    }
    try {
      view.webContents.close();
    } catch {
      /* already closed */
    }
  }
  if (r.forwarder) {
    const forwarder = r.forwarder;
    r.forwarder = null;
    await forwarder.close().catch(() => {});
  }
  if (r.session) {
    const ses = r.session;
    r.session = null;
    // In-memory to begin with; cleared anyway so nothing outlives the run even while the app does.
    await ses.clearStorageData().catch(() => {});
    await ses.clearCache().catch(() => {});
  }
};

const teardown = async () => {
  const previous = run;
  run = null;
  if (previous) {
    previous.done = true;
    await closeBrowser(previous);
  }
};

const startConnect = async (claim) => {
  await teardown();
  const r = { id: ++runSeq, done: false, refusedIds: new Set(), captured: false };
  run = r;
  focusWindow();
  setState({ phase: 'opening' });

  let opened;
  try {
    opened = await api.open(claim);
  } catch (err) {
    return fail(r, messageForOpen(err?.code), err);
  }
  if (r !== run) return;
  r.token = opened.sessionToken;
  r.account = opened.account;
  r.expiresAt = opened.expiresAt;
  log(`run ${r.id}: pass opened for @${opened.account?.username} (${opened.identity?.profile} profile)`);

  try {
    r.forwarder = await startForwarder({
      tunnelUrl: opened.tunnel.url,
      sessionToken: opened.sessionToken,
      onFatal: (reason) => fail(r, messageForTunnel(reason)),
      log: (line) => log(`tunnel: ${line}`),
    });
  } catch (err) {
    return fail(r, messageForTunnel('proxy_error'), err);
  }
  if (r !== run) return closeBrowser(r);

  // A partition with no `persist:` prefix is in memory: cookies, storage and cache live exactly as
  // long as the session object, and the session object as long as the run.
  const ses = session.fromPartition(`onlyx-login-${r.id}-${Date.now()}`);
  r.session = ses;
  await ses.setProxy(r.forwarder.proxyConfig);
  if (r !== run) return closeBrowser(r);
  ses.setUserAgent(opened.identity.userAgent, opened.identity.acceptLanguage ?? 'en-US,en;q=0.9');
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const secure = typeof details?.requestingUrl === 'string' && details.requestingUrl.startsWith('https://');
    if (permission === 'media' && secure) {
      // The selfie check. On macOS the system asks once, app-wide; ask before the page does so a
      // refusal lands on our screen and not inside the vendor's iframe.
      if (process.platform === 'darwin' && typeof systemPreferences?.askForMediaAccess === 'function') {
        void systemPreferences
          .askForMediaAccess('camera')
          .then((granted) => callback(granted !== false))
          .catch(() => callback(true));
        return;
      }
      return callback(true);
    }
    callback(['fullscreen', 'clipboard-sanitized-write'].includes(permission) && secure);
  });
  ses.setPermissionCheckHandler((_contents, permission, origin) => {
    const secure = typeof origin === 'string' && origin.startsWith('https://');
    return secure && ['media', 'fullscreen', 'clipboard-sanitized-write'].includes(permission);
  });
  ses.on('will-download', (event) => event.preventDefault());
  if (testHooks?.certSha256) {
    // A test's fake OnlyFans serves a self-signed cert; accept exactly that one, by SHA-256 of the
    // DER, and nothing else. Electron reports the fingerprint as `sha256/<base64>`; compare the body.
    ses.setCertificateVerifyProc((request, callback) => {
      const fp = (request.certificate?.fingerprint ?? '').replace(/^sha256\//, '');
      callback(fp === testHooks.certSha256 ? 0 : -3);
    });
  }

  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      // No preload: the page is OnlyFans, and it gets nothing of ours.
    },
  });
  r.view = view;
  const contents = view.webContents;
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  contents.on('login', (event, _details, authInfo, callback) => {
    // The forwarder's own challenge (tunnel.js). Anything else — a site asking for basic auth —
    // is left to Chromium, which has no UI for it here and cancels.
    if (authInfo?.isProxy && r.forwarder && Number(authInfo.port) === r.forwarder.port) {
      event.preventDefault();
      callback(r.forwarder.auth.username, r.forwarder.auth.password);
    }
  });

  // Attach the view and warm the renderer with a blank page BEFORE enabling CDP: a WebContentsView's
  // renderer does not exist until it is in a window and something has loaded, and the Page domain
  // hangs without one. about:blank makes no request, so it needs no proxy and trips no guard.
  win.contentView.addChildView(view);
  await contents.loadURL('about:blank').catch(() => {});
  if (r !== run) return closeBrowser(r);

  const httpsOnly = (event, url) => {
    if (!/^https:\/\//i.test(url) && url !== 'about:blank') {
      log(`run ${r.id}: blocked navigation to ${url.slice(0, 80)}`);
      event.preventDefault();
    }
  };
  contents.on('will-navigate', httpsOnly);
  contents.on('will-redirect', httpsOnly);
  contents.setWindowOpenHandler(({ url }) => {
    // One view, no popups: a sign-in provider that insists on a popup is not one the seat could
    // resume anyway. An https target is loaded in place instead.
    if (/^https:\/\//i.test(url)) void contents.loadURL(url);
    return { action: 'deny' };
  });
  contents.on('render-process-gone', (_event, details) => {
    fail(r, { title: 'The sign-in window stopped', detail: `Please open the link again (${details?.reason ?? 'crashed'}).` });
  });

  try {
    r.identity = await attachIdentity(contents, opened.identity, {
      onMe: (me) => onMe(r, me),
      log: (line) => log(`run ${r.id}: ${line}`),
    });
  } catch (err) {
    return fail(r, { title: 'Could not prepare the sign-in window', detail: 'Please open the link again.' }, err);
  }
  if (r !== run) return closeBrowser(r);

  setState({ phase: 'signin', username: opened.account?.username ?? null, expiresAt: opened.expiresAt });
  layout();
  // Bare origin: a guest lands on the sign-in form; anyone still signed in from a previous run
  // cannot be, because the partition is new.
  void contents.loadURL('https://onlyfans.com/').catch((err) => {
    log(`run ${r.id}: initial load: ${String(err?.message ?? err).slice(0, 120)}`);
  });
};

/** OnlyFans answered `/users/me`. Named a user = signed in; capture once the last cookies land. */
const onMe = (r, me) => {
  if (stale(r) || !me) return;
  if (r.captured || r.settleTimer) return;
  if (r.refusedIds.has(me.id)) return;
  log(`run ${r.id}: OnlyFans named user ${me.id}${me.username ? ` (@${me.username})` : ''}`);
  r.settleTimer = setTimeout(() => {
    r.settleTimer = null;
    void capture(r, me);
  }, SETTLE_MS);
};

const capture = async (r, me) => {
  if (stale(r) || !r.session || !r.identity) return;
  let cookies;
  try {
    cookies = await r.session.cookies.get({});
  } catch (err) {
    log(`run ${r.id}: cookies unreadable: ${String(err?.message ?? err).slice(0, 120)}`);
    return;
  }
  // `closeBrowser` nulls `session` and `identity`, so a teardown during that read also makes the
  // rest of this function a null dereference.
  if (stale(r) || !r.identity) return;
  if (!hasLoginCookies(cookies)) {
    // Named, but the jar is not there yet: the next `/users/me` will try again.
    log(`run ${r.id}: named a user but the login cookies are not in the jar yet`);
    return;
  }
  const xbc = await r.identity.readXbc().catch(() => null);
  if (stale(r)) return;
  const payload = buildSessionPayload(cookies, xbc);
  r.captured = true;
  setState({ phase: 'captured', username: r.account?.username ?? null });
  log(`run ${r.id}: captured ${payload.cookies.length} cookies${xbc ? ' + device token' : ''}`);

  let result;
  try {
    result = await api.importSession(r.token, { session: payload, ofUserId: me.id, username: me.username });
  } catch (err) {
    if (stale(r)) return;
    const code = err?.code;
    if (code === 'wrong_creator' || code === 'duplicate_account' || code === 'session_unusable') {
      // The pass is still open: she can sign out in the window and sign in with the right account.
      // The refused identity is remembered so the same answer does not capture again on every page.
      r.captured = false;
      if (code !== 'session_unusable') r.refusedIds.add(me.id);
      const message = messageForImport(code);
      setState({ phase: 'signin', username: r.account?.username ?? null, expiresAt: r.expiresAt, notice: message });
      log(`run ${r.id}: import refused (${code}) — waiting for another sign-in`);
      return;
    }
    return fail(r, messageForImport(code), err);
  }
  if (stale(r)) return;
  log(`run ${r.id}: session imported at ${result?.importedAt}; seat ${result?.seat ? `${result.seat.workerId}#${result.seat.seatIndex}` : 'pending'}`);

  // The browser has done its job. Closing it also closes the tunnel, which the API expects: a
  // consumed pass opens no further streams.
  const token = r.token;
  await closeBrowser(r);
  if (r !== run) return;
  setState({ phase: 'verifying', username: r.account?.username ?? null });
  r.pollTimer = setInterval(() => void poll(r, token), STATUS_POLL_MS);
  void poll(r, token);
};

const poll = async (r, token) => {
  if (stale(r)) return;
  let status;
  try {
    status = await api.status(token);
  } catch (err) {
    if (stale(r)) return;
    if (err?.code === 'pass_invalid' || err?.status === 401) {
      // The pass ran out while the seat was still verifying. The import itself is safe on the
      // server; OnlyX will show the outcome to her manager.
      clearInterval(r.pollTimer);
      r.pollTimer = null;
      r.done = true;
      setState({
        phase: 'error',
        username: r.account?.username ?? null,
        title: 'Still connecting',
        detail: 'Your sign-in was received. OnlyX is finishing the connection in the background — your manager will see the result.',
      });
    }
    return;
  }
  if (stale(r)) return;
  if (status.state === 'connected') {
    clearInterval(r.pollTimer);
    r.pollTimer = null;
    r.done = true;
    setState({ phase: 'success', username: status.username ?? r.account?.username ?? null });
  } else if (status.state === 'failed') {
    clearInterval(r.pollTimer);
    r.pollTimer = null;
    r.done = true;
    const message = messageForFailedConnect(status.statusReason);
    setState({ phase: 'error', username: status.username ?? null, title: message.title, detail: message.detail });
  } else {
    setState({ phase: 'verifying', username: status.username ?? r.account?.username ?? null, seatState: status.state });
  }
};

// ---------------------------------------------------------------------------------------------
// The window, the link, the process.
// ---------------------------------------------------------------------------------------------

const createWindow = () => {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: 'OnlyX Login',
    backgroundColor: '#0b0b0f',   // the brand canvas, so the window never flashes a foreign colour
    show: false,
    autoHideMenuBar: true,
  });
  header = new WebContentsView({
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(header);
  header.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  void header.webContents.loadFile(path.join(here, 'ui', 'index.html'));
  header.webContents.on('did-finish-load', () => header.webContents.send('state', state));
  win.on('resize', layout);
  win.once('ready-to-show', () => {
    win.show();
    layout();
  });
  win.on('closed', () => {
    win = null;
    header = null;
    void teardown();
  });
  layout();
};

const buildMenu = () => {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    // The Edit menu is what makes Cmd/Ctrl+V work in the sign-in form; without the roles Electron
    // has no paste on macOS at all.
    { role: 'editMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'OnlyX Login help', click: () => header?.webContents.send('help') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const handleClaim = (claim) => {
  if (!claim) return;
  if (!app.isReady() || !win) {
    pendingClaim = claim;
    return;
  }
  void startConnect(claim);
};

ipcMain.on('action', (_event, name) => {
  if (name === 'close') win?.close();
  else if (name === 'help') header?.webContents.send('help');
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // The running instance receives our argv through `second-instance` and handles the link.
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    focusWindow();
    handleClaim(claimFromArgv(argv));
  });
  // macOS delivers the link as an event, possibly before `ready`.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const parsed = parseDeepLink(url);
    if (parsed) handleClaim(parsed.claim);
  });

  try {
    if (packaged || process.platform === 'darwin') app.setAsDefaultProtocolClient(SCHEME);
    else if (process.argv[1]) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } catch (err) {
    log(`protocol registration: ${String(err?.message ?? err).slice(0, 120)}`);
  }

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    const claim = pendingClaim ?? claimFromArgv(process.argv);
    pendingClaim = null;
    if (claim) handleClaim(claim);
  });

  app.on('activate', () => {
    if (!win) createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    void teardown();
  });
}

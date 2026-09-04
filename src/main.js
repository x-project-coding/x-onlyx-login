/**
 * OnlyX Login — the desktop app a creator opens from a link to sign in to OnlyFans for her
 * OnlyX-managed account.
 *
 * The flow, end to end:
 *
 *   link opened  ->  POST /connect-app/open        the claim becomes a 45-minute pass: an identity
 *                                                  to present, a token to hold — and the server's
 *                                                  decision on where the traffic flows: a tunnel,
 *                                                  or `tunnel: null`
 *                ->  loopback forwarder (tunnel.js) ONLY when a tunnel was offered: every byte of
 *                                                  the sign-in browser rides the account's own
 *                                                  proxy, via the OnlyX API. With `tunnel: null`
 *                                                  nothing is bound and the sign-in runs over the
 *                                                  machine's own network — see startConnect for
 *                                                  why that is the shipped default
 *                ->  sign-in view                  an in-memory browser wearing the seat's identity
 *                                                  (identity.js); the creator signs in, passes the
 *                                                  selfie check with her own camera
 *                ->  POST /connect-app/session     the jar, the moment OnlyFans names her
 *                ->  GET  /connect-app/status      polled until the seat has adopted the session
 *                ->  success
 *
 * Nothing is persisted: the browser partition is in memory and dropped with the run, the token
 * lives in this process for the pass's lifetime, and no file is written by the app.
 *
 * The one exception, and it is opt-in: `ONLYX_LOGIN_DIAG` makes the run write a record of what the
 * sign-in view was allowed to do — navigations, denied popups, blocked navigations, permission
 * verdicts, page errors — to a local file (diagnostics.js). Off unless asked for, and it never
 * writes a cookie, a token, a query-string value or anything the creator types.
 */

import { app, BrowserWindow, WebContentsView, session, ipcMain, Menu, shell, systemPreferences } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OnlyxApi } from './api.js';
import { resolveApiBase } from './config.js';
import { SCHEME, claimFromArgv, parseDeepLink } from './deep-link.js';
import {
  attachContentsDiagnostics,
  diagnosticTarget,
  openRecorder,
  popupsAllowed,
  redactUrl,
} from './diagnostics.js';
import { attachIdentity } from './identity.js';
import { cleanUserAgent, isNative } from './native-identity.js';
import { messageForFailedConnect, messageForImport, messageForOpen, messageForTunnel } from './messages.js';
import { buildSessionPayload, hasLoginCookies } from './session-capture.js';
import { startForwarder } from './tunnel.js';
import { isCertSigned, mayPaintUpdate, updateCheckVerdict, updateInstallVerdict } from './update-policy.js';

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

/**
 * The sign-in view's diagnostic record — null on every run nobody asked for one (diagnostics.js).
 * Armed once, at ready, so a link that arrives before the window still lands in the same file.
 */
let diag = null;
const record = (kind, fields) => {
  try {
    diag?.record(kind, fields);
  } catch {
    /* a diagnostic must never break a sign-in */
  }
};

/**
 * May a vendor handoff have a real popup window? Off by default — see the window-open handler.
 * Read once at startup so one run cannot change policy halfway through.
 */
const allowPopups = popupsAllowed({ env: process.env });
/** A popup a vendor asked for is one window; a page that asks for twelve is not a handoff. */
const POPUP_LIMIT = 2;

const setState = (next) => {
  state = { ...next, at: new Date().toISOString() };
  record('state', { phase: next.phase, title: next.title ?? null, seatState: next.seatState ?? null });
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
  for (const detach of r.detach ?? []) {
    try {
      detach();
    } catch {
      /* the contents are already gone */
    }
  }
  r.detach = [];
  // Popups go before the view that opened them: Electron closes a child with its opener anyway,
  // but a window left on screen after the run ended is a window the creator has to close herself.
  for (const popup of r.popups ?? []) {
    try {
      if (!popup.isDestroyed()) popup.destroy();
    } catch {
      /* already gone */
    }
  }
  r.popups = [];
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

/**
 * THE WINDOW-OPEN GUARD, AND WHY IT IS THE MOST DANGEROUS ONE IN THIS FILE.
 *
 * v1.0.0 answered every `window.open` with "deny", and for an https target loaded it IN THE SAME
 * VIEW instead. That is not a milder version of a popup — it is the destruction of the page that
 * asked. The opener's document, its timers, its websockets, its `message` listeners and every
 * variable it held are gone, `window.opener` in the new document is null, and a `window.open()`
 * that resolved to `about:blank` (the shape used to open a window and then fill it in) simply
 * returned null to a caller about to dereference it.
 *
 * Three things a real popup would have carried are also lost, and each one on its own can make a
 * vendor answer a later request "not found":
 *   - the POST body, when the handoff was a `<form target="_blank">` — `loadURL` is a GET;
 *   - the `Referer`, since a browser-initiated `loadURL` sends none and looks to the far end like
 *     a URL typed into an address bar (`Sec-Fetch-Site: none`);
 *   - `window.name`, which some flows use to carry a channel id.
 *
 * On 2026-09-02 OnlyFans asked the operator to confirm his identity, offered a QR code, and the
 * phone that scanned it was told `Error.Header.NotFound` — the vendor could not resolve a message
 * for the state it was in, i.e. the verification session behind that QR did not exist. Whether a
 * popup was ever attempted is UNKNOWN, because this handler did not log. It does now.
 *
 * So, in order: the two losses that need no hypothesis to justify fixing are fixed (the referrer
 * and the post body now ride the in-place load), and the popup itself is available but OFF —
 * `ONLYX_LOGIN_POPUPS=allow` — so a single reproduction can settle it without shipping a guess.
 * A popup, when allowed, is a real window with the SAME locked-down webPreferences, the SAME
 * in-memory session, the same navigation guard, the same identity, and a hard cap.
 */
const onWindowOpen = (r, contents, tag, details) => {
  const { url, frameName, disposition, features, postBody, referrer } = details ?? {};
  const https = /^https:\/\//i.test(url ?? '');
  const asPopup = https && allowPopups && (r.popups?.length ?? 0) < POPUP_LIMIT;
  const decision = asPopup ? 'popup' : https ? 'load-in-place' : 'deny';
  log(`run ${r.id}: ${tag} asked for a window (${disposition ?? 'default'}) — ${decision}`);
  record('window-open', {
    run: r.id,
    view: tag,
    url: redactUrl(url),
    frameName: frameName || null,
    disposition: disposition ?? null,
    features: features || null,
    // A form handoff carries its session HERE, not in the URL, and the in-place load used to drop
    // it on the floor. Recorded as a fact, never as content.
    postBodyParts: postBody?.data?.length ?? 0,
    postContentType: postBody?.contentType ?? null,
    referrerPolicy: referrer?.policy ?? null,
    hasReferrer: Boolean(referrer?.url),
    decision,
  });
  if (asPopup) return { action: 'allow', overrideBrowserWindowOptions: popupWindowOptions() };
  if (https) {
    const options = {};
    if (referrer?.url) options.httpReferrer = referrer;
    if (postBody?.data?.length) {
      options.postData = postBody.data;
      const boundary = postBody.boundary ? `; boundary=${postBody.boundary}` : '';
      options.extraHeaders = `content-type: ${postBody.contentType}${boundary}`;
    }
    // Caught. `loadURL` rejects whenever a navigation is superseded — ERR_ABORTED (-3), which the
    // e2e reproduces every run — and the original call had no catch, so that rejection went
    // unhandled. MEASURED: Electron 44 does not kill the main process for it, so this is not a
    // crash fix; it is the difference between a silent abort and a line saying the handoff's own
    // load failed, which is the whole point of this lane.
    void contents.loadURL(url, options).catch((err) => {
      log(`run ${r.id}: ${tag} in-place load failed: ${String(err?.message ?? err).slice(0, 120)}`);
    });
  }
  return { action: 'deny' };
};

/**
 * What a popup is allowed to be: no Node, no preload, no persistence of its own. Deliberately NOT
 * given a `session` — a window opened by the page inherits its opener's, which is the run's
 * in-memory partition, and `adoptPopup` refuses any window where that stops being true.
 *
 * MEASURED, so nobody trusts the wrong line: setting `nodeIntegration: true` HERE does not give the
 * popup Node — the e2e's `node=false` probe still passes with that mutation, because Electron
 * derives a page-opened window's security preferences from its opener rather than from these
 * options. So the powerlessness is inherited, and the assertion in vendor-popup.test.js is what
 * actually holds it. These stay as an explicit statement of intent and as cover for the day that
 * inheritance changes; they are not, today, what enforces it.
 */
const popupWindowOptions = () => ({
  width: 560,
  height: 760,
  autoHideMenuBar: true,
  backgroundColor: '#0b0b0f',
  parent: win ?? undefined,
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    spellcheck: false,
  },
});

/** A popup that was allowed: same guards, same identity, closed with the run. */
const adoptPopup = (r, child, details) => {
  const contents = child.webContents;
  const kill = (reason) => {
    record('popup-refused', { run: r.id, reason, url: redactUrl(details?.url) });
    try {
      child.destroy();
    } catch {
      /* already gone */
    }
  };
  if (r !== run || r.done) return kill('run-over');
  // The popup must share the run's jar. If Electron ever stopped handing a page-opened window its
  // opener's session, the popup would be a second browser with a second cookie store — and the
  // sign-in completed in it would not be the one this app captures.
  if (r.session && contents.session !== r.session) return kill('foreign-session');
  r.popups.push(child);
  const tag = `popup${r.popups.length}`;
  child.on('closed', () => {
    r.popups = (r.popups ?? []).filter((w) => w !== child);
  });
  guardContents(r, contents, tag);
  record('popup-opened', { run: r.id, view: tag, url: redactUrl(details?.url) });
  // The popup wears the same identity as the view that opened it — best effort and never awaited.
  // Its first document is already being created, so the pins reach the popup's NEXT document while
  // the user-agent override and its client hints apply from its next request; a popup carrying
  // Electron's own fingerprint beside a pinned opener would be a contradiction of its own.
  //
  // IN NATIVE MODE THERE IS NOTHING TO CARRY, and that is not a gap. The honest identity is the
  // SESSION's user agent (see the note beside `ses.setUserAgent`), and a page-opened window
  // inherits its opener's session — which `kill('foreign-session')` above is what guarantees. So a
  // native popup is born matching its opener on the first document, with no second leg needed;
  // `attachIdentity` still runs, and still installs the WebAuthn hardening, which is the one thing
  // a popup must not be born without.
  if (!r.identitySpec) return;
  void attachIdentity(contents, r.identitySpec, {
    onMe: (me) => onMe(r, me),
    log: (line) => log(`run ${r.id}: ${tag}: ${line}`),
  })
    .then((handle) => {
      // The run can end while the attach is in flight, and a debugger left attached to a destroyed
      // window is a leak. A cleanup path, not a behaviour: no test drives a teardown into this
      // exact window, and a mutation to it survives the suite.
      if (r !== run || r.done || !r.popups.includes(child)) return handle.detach();
      r.detach.push(() => handle.detach());
    })
    .catch((err) => {
      record('popup-identity-failed', { run: r.id, view: tag, error: String(err?.message ?? err).slice(0, 120) });
    });
};

/**
 * Every guard a browsing context of ours gets, in one place so a popup cannot be born with fewer
 * than the view that opened it.
 */
const guardContents = (r, contents, tag) => {
  // Electron 44 passes a details object and keeps the old positional `url` after it, deprecated.
  // Read whichever is there: a `url` that arrived `undefined` would fail the https test below and
  // block EVERY navigation, which is a dead sign-in rather than a loud one.
  const navUrl = (details, positional) =>
    typeof details?.url === 'string' ? details.url : typeof positional === 'string' ? positional : '';
  const httpsOnly = (event, positional) => {
    const url = navUrl(event, positional);
    if (!/^https:\/\//i.test(url) && url !== 'about:blank') {
      log(`run ${r.id}: blocked navigation to ${url.slice(0, 80)}`);
      // Blocking is silent to the page — `preventDefault` raises nothing a site can catch — so
      // without this record a guard of ours and a vendor outage look identical from the outside.
      record('navigation-blocked', { run: r.id, view: tag, url: redactUrl(url) });
      event.preventDefault();
    }
  };
  contents.on('will-navigate', httpsOnly);
  contents.on('will-redirect', httpsOnly);
  contents.setWindowOpenHandler((details) => onWindowOpen(r, contents, tag, details));
  contents.on('did-create-window', (child, childDetails) => adoptPopup(r, child, childDetails));
  if (diag) r.detach.push(attachContentsDiagnostics(contents, diag, { tag }));
};

const startConnect = async (claim) => {
  await teardown();
  const r = { id: ++runSeq, done: false, refusedIds: new Set(), captured: false, popups: [], detach: [] };
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
  r.identitySpec = opened.identity;
  log(
    `run ${r.id}: pass opened for @${opened.account?.username} ` +
      `(${opened.identity?.profile} profile, ${isNative(opened.identity) ? 'this machine' : 'seat'} identity)`,
  );
  record('run-open', {
    run: r.id,
    username: opened.account?.username ?? null,
    identityProfile: opened.identity?.profile ?? null,
    // The identity itself is the other half of a vendor's device check, so its SHAPE is recorded:
    // never the pass token, never a cookie — a user agent, a platform, and the LENGTH of the pin
    // script, which is all that is needed to tell "the pins were applied" from "they were not".
    //
    // `identitySource` is the field that says which question the rest of this line is answering.
    // In `native` the server sends no claims at all, so `userAgent` is the empty string, `platform`
    // and `timezone` are null and `initScriptChars` is 0 — a row that would read as "the server
    // sent nothing" without it, when it means "the app was told to be itself".
    identitySource: opened.identity?.source ?? 'seat',
    userAgent: opened.identity?.userAgent ?? null,
    platform: opened.identity?.platform ?? null,
    timezone: opened.identity?.timezone ?? null,
    initScriptChars: typeof opened.identity?.initScript === 'string' ? opened.identity.initScript.length : 0,
    tunnel: Boolean(opened.tunnel?.url),
    popupsAllowed: allowPopups,
  });

  // THE SERVER DECIDES WHERE THE SIGN-IN'S TRAFFIC FLOWS (XOF_CONNECT_APP_TUNNEL on x-onlyfans),
  // and says so by offering a tunnel or `tunnel: null`. A tunnel = every stream rides the
  // account's residential proxy through the forwarder, exactly as before. No tunnel = the sign-in
  // runs over THIS machine's own network: OnlyFans' identity vendor compares this browser's
  // network with the phone that scans its QR ("please make sure both devices are connected to the
  // same network", hit in production 2026-09-02), and behind the proxy the two can never match.
  // The session is then created on the creator's own IP and later used by the seat from the
  // account's proxy — that IP jump is a KNOWN, ACCEPTED sign-out risk, chosen by the operator with
  // eyes open. Do not "fix" it here by requiring a tunnel again; and do not decide the mode here
  // either — the server owns the switch precisely so installed copies (which unsigned mac builds
  // cannot auto-update) follow a container env change instead of a reinstall.
  const tunnelUrl = opened.tunnel?.url ?? null;
  if (tunnelUrl) {
    try {
      r.forwarder = await startForwarder({
        tunnelUrl,
        sessionToken: opened.sessionToken,
        onFatal: (reason) => fail(r, messageForTunnel(reason)),
        log: (line) => log(`tunnel: ${line}`),
      });
    } catch (err) {
      return fail(r, messageForTunnel('proxy_error'), err);
    }
    if (r !== run) return closeBrowser(r);
  } else {
    log(`run ${r.id}: no tunnel offered — signing in over this machine's own network`);
  }

  // A partition with no `persist:` prefix is in memory: cookies, storage and cache live exactly as
  // long as the session object, and the session object as long as the run.
  const ses = session.fromPartition(`onlyx-login-${r.id}-${Date.now()}`);
  r.session = ses;
  if (r.forwarder) {
    await ses.setProxy(r.forwarder.proxyConfig);
    if (r !== run) return closeBrowser(r);
  }
  // With no tunnel, setProxy is deliberately NOT called at all: no forwarder, no loopback
  // listener, no per-run credential — nothing of ours between her browser and OnlyFans. The
  // session keeps the machine's normal network path (a system proxy included, if her machine has
  // one), which is the same route her everyday browser takes and therefore the network the
  // vendor's phone check is comparing against. Forcing mode:'direct' here would instead strand
  // any creator whose machine can only reach the internet through a configured proxy.
  // THE ONE PLACE THE USER-AGENT IS SET, and it has to be HERE — before the view below exists.
  //
  // Measured 2026-09-02: a renderer takes its `navigator.userAgent` when it is created, and
  // `session.setUserAgent` after that moves only the outgoing header. Setting it later left the
  // page saying `Electron/44.1.1` while the wire said Chrome — a contradiction manufactured by the
  // code that exists to remove them. It is also the only half a SERVICE WORKER reads, and OnlyFans
  // registers one, so a page-level CDP override could never stand in for it.
  //
  // In native mode the honest string is this engine's own with the app and Electron tokens taken
  // out and the version reduced (native-identity.js) — no page needed to work it out, which is why
  // it can happen this early. In seat mode it is whatever the server sent, exactly as before.
  if (isNative(opened.identity)) {
    const clean = cleanUserAgent(ses.getUserAgent());
    // Untouched rather than mangled: an `Electron/` token is a tell, but a User-Agent this code
    // half-rewrote is a tell AND a mystery. No `acceptLanguage` either — the machine's own is the
    // only well-formed answer, and the seat's `en-US,en;q=0.9` becomes the language TAG
    // `en;q=0.9` once it goes through these APIs (measured).
    if (clean) ses.setUserAgent(clean);
    log(`run ${r.id}: native identity: ${clean ?? `${ses.getUserAgent()} (uncleanable, left alone)`}`);
  } else {
    ses.setUserAgent(opened.identity.userAgent, opened.identity.acceptLanguage ?? 'en-US,en;q=0.9');
  }
  // Raised to her screen rather than swallowed: the sign-in window stays open, because the rest of
  // the sign-in still works and only the selfie step is blocked.
  const onMediaBlocked = (kinds) => {
    if (r !== run || r.done || r.mediaWarned) return;
    r.mediaWarned = true;
    log(`run ${r.id}: macOS is blocking ${kinds.join(' and ')} for this app`);
    setState({
      phase: 'signin',
      username: r.account?.username ?? null,
      expiresAt: r.expiresAt,
      notice: {
        title: `Your Mac is blocking the ${kinds.join(' and ')}`,
        detail:
          'Open System Settings › Privacy & Security › Camera, switch on OnlyX Login, then open your link again. macOS only asks once, so it will not prompt you a second time.',
      },
    });
  };

  ses.setPermissionRequestHandler((_contents, permission, answer, details) => {
    const secure = typeof details?.requestingUrl === 'string' && details.requestingUrl.startsWith('https://');
    // Wrapped, not sprinkled: every branch below reaches one `callback`, so one place records the
    // verdict. A permission this app denies is a capability the page loses with no way to say so —
    // the exact class of failure the diagnostic exists to make visible.
    const callback = (granted) => {
      record('permission-request', {
        run: r.id,
        permission,
        granted: Boolean(granted),
        secure,
        url: redactUrl(details?.requestingUrl),
        mediaTypes: Array.isArray(details?.mediaTypes) ? details.mediaTypes : null,
      });
      answer(granted);
    };
    if (permission === 'media' && secure) {
      // The selfie check. On macOS the system asks ONCE, app-wide and for ever: a creator who
      // clicks "Don't Allow" — a reflexive click — is refused by `askForMediaAccess` on every run
      // after, with no second prompt. Silently denying her then kills the identity check inside the
      // vendor's iframe, where she cannot see why, and "allow the camera when your computer asks"
      // becomes a lie: it will never ask again. So a standing denial is DETECTED and surfaced with
      // the one instruction that recovers it.
      if (process.platform === 'darwin' && typeof systemPreferences?.askForMediaAccess === 'function') {
        // Ask for what the page actually wants; the mic usage string and entitlement exist, and
        // hard-coding 'camera' would leave an audio track failing with the prompt never shown.
        const wanted = Array.isArray(details?.mediaTypes) && details.mediaTypes.length
          ? details.mediaTypes
          : ['video'];
        const kinds = [...new Set(wanted.map((t) => (t === 'audio' ? 'microphone' : 'camera')))];
        if (typeof systemPreferences.getMediaAccessStatus === 'function') {
          const blocked = kinds.filter((k) => systemPreferences.getMediaAccessStatus(k) === 'denied');
          if (blocked.length) {
            onMediaBlocked?.(blocked);
            return callback(false);
          }
        }
        void Promise.all(kinds.map((k) => systemPreferences.askForMediaAccess(k)))
          .then((results) => {
            const granted = results.every((ok) => ok !== false);
            if (!granted) onMediaBlocked?.(kinds);
            callback(granted);
          })
          .catch(() => callback(true));
        return;
      }
      return callback(true);
    }
    callback(['fullscreen', 'clipboard-sanitized-write'].includes(permission) && secure);
  });
  const checksSeen = new Set();
  ses.setPermissionCheckHandler((_contents, permission, origin) => {
    const secure = typeof origin === 'string' && origin.startsWith('https://');
    const allowed = secure && ['media', 'fullscreen', 'clipboard-sanitized-write'].includes(permission);
    // Once per answer, not once per call: Chromium re-checks a permission on every use, and a page
    // polling `permissions.query` would otherwise bury everything else in the file.
    const key = `${permission}:${allowed}`;
    if (!checksSeen.has(key)) {
      checksSeen.add(key);
      record('permission-check', { run: r.id, permission, allowed, origin: redactUrl(origin) });
    }
    return allowed;
  });
  ses.on('will-download', (event, item) => {
    record('download-blocked', {
      run: r.id,
      url: redactUrl(typeof item?.getURL === 'function' ? item.getURL() : null),
      mimeType: typeof item?.getMimeType === 'function' ? item.getMimeType() : null,
    });
    event.preventDefault();
  });
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
  if (r.forwarder) {
    // ONLY WITH A PROXY. This exists to stop WebRTC opening a UDP path AROUND the forwarder and
    // showing OnlyFans the machine's real address — a leak that can only happen when there is a
    // proxy to leak around. With `tunnel: null` there is nothing to bypass, and the policy then
    // just takes UDP away from a browser that is meant to behave like the creator's everyday one
    // (the same reasoning as the deliberate absence of `setProxy` above). Not proven to be
    // involved in the 2026-09-02 identity-check failure — `getUserMedia` is untouched by this, so
    // it cannot be what breaks a selfie — but a guard whose reason is absent should be too.
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  }
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

  guardContents(r, contents, 'signin');
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
  // CLAIMED SYNCHRONOUSLY, before the first await. `captured` is only set once the jar is in hand,
  // and OnlyFans polls `/users/me` often enough that a second answer arriving during the cookie
  // read, the token retries or the import itself would clear every later guard and import twice on
  // a single-use token. Released on every path that does not reach the import.
  if (r.capturing) return;
  r.capturing = true;
  try {
    await captureInner(r, me);
  } finally {
    r.capturing = false;
  }
};

const captureInner = async (r, me) => {
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
  // The device token, retried. The API refuses an import without one — a seat that adopts a jar
  // with no token clears its own and lets OnlyFans see an unrecognised device — and OnlyFans writes
  // `bcTokenSha` around sign-in rather than exactly at it, so one read a moment too early would
  // cost her a whole round trip for nothing.
  let xbc = null;
  for (let attempt = 0; attempt < 4 && !xbc; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
    if (stale(r) || !r.identity) return;
    xbc = await r.identity.readXbc().catch(() => null);
  }
  if (stale(r)) return;
  if (!xbc) {
    // Left uncaptured so the next `/users/me` tries again, rather than spending the pass on a jar
    // the API will refuse.
    log(`run ${r.id}: signed in but the device token is not in storage yet — waiting`);
    return;
  }
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

  // The browser has done its job. Closing it also closes the tunnel when one was in use, which
  // the API expects: a consumed pass opens no further streams.
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
// Auto-update: everyone on the new version without a reinstall — never at a sign-in's expense.
//
// The only thing written to disk is the staged installer, in the OS's cache location — the app
// binary itself, no creator data — which is what "the app persists nothing" has always meant:
// nothing OF A RUN outlives the run.
// ---------------------------------------------------------------------------------------------

let updater = null; // the armed electron-updater instance; stays null whenever updates are off
let updateDownloaded = false;

/**
 * Is the running binary certificate-signed? Squirrel.Mac's opinion is the one that counts, and it
 * reads the signature, not a config — so ask codesign about the actual executable. Any failure
 * (no codesign, timeout) resolves false: a build that cannot PROVE it is signed must not promise
 * an update it may be unable to install.
 */
const macCertSigned = () =>
  new Promise((resolve) => {
    execFile('codesign', ['-dvv', process.execPath], { timeout: 10_000 }, (_err, stdout, stderr) => {
      resolve(isCertSigned(`${stdout ?? ''}\n${stderr ?? ''}`));
    });
  });

/** Update screens may replace only the idle screen — never a run's (update-policy.js says why). */
const paintUpdate = (phase, version) => {
  if (!mayPaintUpdate(state.phase)) return;
  setState({ phase, version: version ?? null });
};

/**
 * WHEN: once, at launch, in the background, after the link (if any) has been dispatched.
 *
 * This is a short-lived utility, usually launched BY a link that immediately starts a sign-in — so
 * "check when idle" would mean never, and "check after the run" would give a 100+ MB download a
 * few seconds before the creator closes the app. Launch is the one moment every session has, and
 * it hands the download the whole sign-in (minutes) to finish quietly. The check races nothing:
 * it cannot paint over a run (paintUpdate) and cannot restart the app (install happens on quit,
 * or via the idle screen's button, both guarded by update-policy.js).
 *
 * Every failure in here is logged and swallowed — offline, GitHub down, rate-limited. The app's
 * job is the sign-in; an update must never block it, and a failed check is not an error the
 * creator can act on, so she is never shown one.
 */
const startUpdater = async () => {
  const signed = process.platform === 'darwin' ? await macCertSigned() : true;
  const verdict = updateCheckVerdict({ packaged, platform: process.platform, signed });
  if (!verdict.check) {
    // 'mac_unsigned' is expected for an unpackaged or locally unsigned build: Squirrel.Mac refuses
    // to install onto an unsigned (or ad-hoc) build, so nothing is checked, downloaded or promised
    // — no broken retry loop, no "update ready" it cannot honour. The probe reads the running
    // binary, so every Developer ID-signed release arms updates without a build flag.
    log(`auto-update: skip (${verdict.reason})`);
    return;
  }
  let mod;
  try {
    // Loaded lazily: if the dependency is broken or missing, the sign-in must still work.
    mod = await import('electron-updater');
  } catch (err) {
    log(`auto-update: unavailable (${String(err?.message ?? err).slice(0, 120)})`);
    return;
  }
  const autoUpdater = mod.default?.autoUpdater ?? mod.autoUpdater;
  autoUpdater.logger = null; // milestones are logged below, once each
  autoUpdater.autoDownload = true;
  // The natural install moment for an app that is opened for minutes and then closed: on quit.
  // The creator finishes, closes the window as she always does, the staged update applies itself,
  // and the next link opens the new version. No prompt, and no restart she did not ask for.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    log(`auto-update: ${info?.version ?? 'a newer version'} available, downloading in the background`);
    paintUpdate('update-downloading', info?.version);
  });
  autoUpdater.on('update-not-available', () => log('auto-update: up to date'));
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    log(`auto-update: ${info?.version ?? 'update'} downloaded; installs when the app closes`);
    paintUpdate('update-ready', info?.version);
  });
  autoUpdater.on('error', (err) => {
    // Logged, never surfaced: she cannot act on it, and an error screen here would read as HER
    // sign-in failing. If the downloading screen was promised, hand it back to idle rather than
    // leave a spinner that spins for ever.
    log(`auto-update: ${String(err?.message ?? err).slice(0, 160)}`);
    if (state.phase === 'update-downloading') setState({ phase: 'idle' });
  });

  updater = autoUpdater;
  await autoUpdater.checkForUpdates().catch(() => {
    /* already logged by the 'error' handler */
  });
};

/**
 * The update-ready screen's Restart button. Verdict taken at CLICK time, not paint time: a link
 * can arrive between the screen appearing and the press, and restarting then would destroy the
 * run it just started.
 */
const installUpdateNow = () => {
  const verdict = updateInstallVerdict({ runActive: Boolean(run && !run.done), downloaded: updateDownloaded });
  if (!updater || !verdict.install) {
    log(`auto-update: restart refused (${updater ? verdict.reason : 'not_armed'})`);
    return;
  }
  // (silent, relaunch): she asked to restart, so the app comes back; the installer shows no UI.
  updater.quitAndInstall(true, true);
};

// ---------------------------------------------------------------------------------------------
// The window, the link, the process.
// ---------------------------------------------------------------------------------------------

/**
 * Switch the sign-in record on, if asked. OFF on every run that does not set `ONLYX_LOGIN_DIAG`,
 * and armed here — before the window and before any link is dispatched — so a link that arrived
 * during launch is recorded from its first state change.
 *
 * The path is printed rather than guessed at: an operator reproducing a fault should not have to
 * know where an Electron app keeps its logs on his platform.
 */
const armDiagnostics = () => {
  let logDir;
  try {
    logDir = app.getPath('logs');
  } catch {
    logDir = app.getPath('userData');
  }
  const file = diagnosticTarget({ env: process.env, packaged, logDir });
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    diag = openRecorder({
      file,
      meta: {
        app: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        platform: `${process.platform}-${process.arch}`,
        packaged,
        popupsAllowed: allowPopups,
      },
    });
    log(`diagnostics: recording this sign-in to ${file}`);
  } catch (err) {
    // A record we cannot write is a record we do not keep — never a sign-in we do not run.
    log(`diagnostics: not recording (${String(err?.message ?? err).slice(0, 120)})`);
    diag = null;
  }
};

const createWindow = () => {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: 'OnlyX Login',
    backgroundColor: '#0b0b0f',   // the brand canvas, so the window never flashes a foreign colour
    // Shown from birth, deliberately. v1.0.0 used show:false + 'ready-to-show', but that event
    // belongs to the window's OWN webContents — which never loads anything here, all content being
    // child WebContentsViews — so it never fired, and a launch from the icon (no link, so no
    // focusWindow either) ran forever with no window at all. An unconditional show has no event to
    // miss, and backgroundColor keeps the frame on-brand until the header view paints.
    show: true,
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
  else if (name === 'install-update') installUpdateNow();
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
    armDiagnostics();
    buildMenu();
    createWindow();
    const claim = pendingClaim ?? claimFromArgv(process.argv);
    pendingClaim = null;
    if (claim) handleClaim(claim);
    // After the link is dispatched, so the check can never delay the reason the app was opened.
    void startUpdater();
  });

  // Quits on every platform, macOS included. This is a single-shot utility opened BY a link, not an
  // app to keep in the dock: with nothing on screen there is nothing for it to do, and a link
  // cold-starts it again in a second. There is deliberately no `activate` handler — one could never
  // fire, since the process is gone by the time the dock icon could be clicked.
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    void teardown();
  });
}

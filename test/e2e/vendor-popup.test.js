/**
 * THE HYPOTHESIS UNDER TEST, made runnable.
 *
 * v1.0.0 answered every `window.open` with "deny" and, for an https target, loaded it IN THE SAME
 * VIEW. That is not a milder popup — it destroys the page that asked. `window.opener` in the new
 * document is null, the opener's `message` listener is gone with its document, and any state the
 * opener held (a verification session, a channel id, a socket) goes with it. When OnlyFans handed
 * the operator an identity check on 2026-09-02 and the phone that scanned its QR was answered
 * `Error.Header.NotFound`, a handoff of exactly that shape was the leading suspicion — and the app
 * had recorded nothing either way.
 *
 * `ONLYX_LOGIN_POPUPS=allow` turns on a real popup: same locked-down webPreferences, same in-memory
 * session, same navigation guard, same identity, hard cap. This test proves all four, and proves
 * the one property the default behaviour cannot have — the opener survives, and the popup can talk
 * to it. It is OFF by default and this is the only place it runs; the default path is covered by
 * diagnostics.test.js.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';

import { startFakeApi, startFakeOnlyFans } from './fakes.js';

const require = createRequire(import.meta.url);
const appDir = path.resolve(fileURLToPath(import.meta.url), '../../..');
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const makeCert = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyx-e2e-cert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=onlyfans.com',
    '-addext', 'subjectAltName=DNS:onlyfans.com,DNS:www.onlyfans.com',
  ], { stdio: 'pipe' });
  const der = execFileSync('openssl', ['x509', '-in', cert, '-outform', 'DER']);
  const sha256 = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), sha256b64: Buffer.from(sha256).toString('base64'), dir };
};

const readLines = (file) => {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

const waitFor = async (predicate, { timeoutMs = 75_000, exitedRef = () => null } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = predicate();
    if (hit) return hit;
    if (exitedRef()) return null;
    await sleep(200);
  }
  return null;
};

/**
 * The opener. It signs in FIRST so the popup has a jar to prove it shares, opens the window, and
 * only then asks OnlyFans who it is — the answer the app watches for. If the popup had destroyed
 * this document (the default behaviour), the `message` listener below would not exist to hear from
 * it and the delayed `/users/me` would never be sent.
 */
const OPENER_PAGE = `<!doctype html><html><head><meta charset=utf-8><title>OnlyFans</title></head>
<body><h1>opener</h1>
<script>
window.addEventListener('message', (e) => {
  fetch('/probe?leg=opener-heard&data=' + encodeURIComponent(String(e.data)), { credentials: 'include' });
});
(async () => {
  await fetch('/api2/v2/users/me', { credentials: 'include' });     // guest
  await fetch('/login', { method: 'POST', credentials: 'include' }); // sets sess + auth_id
  try { localStorage.setItem('ofBcToken', '0123456789abcdef0123456789abcdef01234567'); } catch (e) {}
  window.open('https://onlyfans.com/popup-leg', 'vendor', 'width=480,height=640');
  await new Promise((r) => setTimeout(r, 2500));
  await fetch('/api2/v2/users/me', { credentials: 'include' });      // 200 with an id -> capture
})();
</script></body></html>`;

/** The popup. Reports what it can see, then tries a navigation the guard must still refuse. */
const POPUP_PAGE = `<!doctype html><html><head><meta charset=utf-8><title>popup</title></head>
<body><h1>popup</h1>
<script>
(async () => {
  // credentials:'include' — the server checks whether this leg carried the run's own cookies.
  // The node flag is the security half: a popup must be as powerless as the view that opened it.
  const node = typeof window.require !== 'undefined' || typeof window.process !== 'undefined' || typeof window.module !== 'undefined';
  await fetch('/probe?leg=popup&opener=' + Boolean(window.opener) + '&node=' + node, { credentials: 'include' });
  try { window.opener.postMessage('handoff-ok', '*'); } catch (e) {
    await fetch('/probe?leg=popup-postmessage-failed', { credentials: 'include' });
  }
  // The popup must be born with the same navigation guard as the view that opened it.
  location.href = 'http://insecure.invalid/from-the-popup';
  // Blocked silently, so this document is still here. Now a navigation the guard DOES allow: the
  // identity pins are installed for a context's NEXT document, so this second leg is the only
  // place a popup's fingerprint can be read.
  await new Promise((r) => setTimeout(r, 1500));
  location.href = 'https://onlyfans.com/popup-leg-2';
})();
</script></body></html>`;

/** The popup's second document — the first one that can carry the run's identity pins. */
const POPUP_PAGE_2 = `<!doctype html><html><head><meta charset=utf-8><title>popup2</title></head>
<body><h1>popup2</h1>
<script>
fetch('/probe?leg=popup2&platform=' + encodeURIComponent(navigator.platform), { credentials: 'include' });
</script></body></html>`;

test('allowed a popup, the vendor gets a real window — locked down, sharing the jar, and its opener still alive', async () => {
  const cert = makeCert();
  const claim = 'e2ePopup_0123456789';
  const of = await startFakeOnlyFans({
    key: cert.key,
    cert: cert.cert,
    pages: { '/': OPENER_PAGE, '/popup-leg': POPUP_PAGE, '/popup-leg-2': POPUP_PAGE_2 },
  });
  const api = await startFakeApi({ tunnelPort: null, userAgent: MAC_UA, claim });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyx-e2e-popup-'));
  const stateFile = path.join(dir, 'states.jsonl');
  const diagFile = path.join(dir, 'signin.log');
  const electron = require('electron');
  const child = spawn(
    electron,
    [
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      `--host-resolver-rules=MAP onlyfans.com 127.0.0.1:${of.port}`,
      appDir, `onlyx-connect://open?c=${claim}`,
    ],
    {
      cwd: appDir,
      env: {
        ...process.env,
        ONLYX_API_BASE: api.base,
        ONLYX_TEST_STATE_FILE: stateFile,
        ONLYX_TEST_CERT_SHA256: cert.sha256b64,
        ONLYX_LOGIN_DIAG: diagFile,
        ONLYX_LOGIN_POPUPS: 'allow',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const logs = [];
  const tap = () => (d) => {
    const text = d.toString();
    logs.push(text);
    for (const line of text.split('\n')) if (line.trim()) console.log(`  [app] ${line}`);
  };
  child.stdout.on('data', tap());
  child.stderr.on('data', tap());
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; console.log(`  [app] exited code=${code} signal=${signal}`); });

  after(async () => {
    try { child.kill('SIGKILL'); } catch {}
    await Promise.all([of.close(), api.close()]);
    fs.rmSync(cert.dir, { recursive: true, force: true });
  });

  const done = await waitFor(
    () => readLines(stateFile).find((s) => s.phase === 'success' || s.phase === 'error'),
    { exitedRef: () => exited },
  );
  if (!done || done.phase !== 'success') {
    const phases = readLines(stateFile).map((s) => s.phase);
    throw new Error(`expected success; phases were [${phases.join(', ')}]\n--- app logs ---\n${logs.join('').slice(-4000)}`);
  }

  const lines = readLines(diagFile);
  const probes = of.state.requests.filter((r) => r.path === '/probe');
  const paths = () => JSON.stringify(of.state.requests.map((r) => `${r.method} ${r.url}`));

  // --- the popup was really a popup -------------------------------------------------------------
  const opened = lines.find((l) => l.kind === 'window-open');
  assert.ok(opened, `the request for a window was recorded: ${JSON.stringify(lines.map((l) => l.kind))}`);
  assert.equal(opened.decision, 'popup', 'with popups allowed, the verdict is a popup');
  assert.ok(lines.some((l) => l.kind === 'popup-opened'), 'and a window was adopted');
  assert.ok(
    !lines.some((l) => l.kind === 'popup-refused'),
    `no popup was refused — a foreign session would show here: ${JSON.stringify(lines.filter((l) => l.kind === 'popup-refused'))}`,
  );

  // --- THE PROPERTY THE DEFAULT BEHAVIOUR CANNOT HAVE -------------------------------------------
  // The opener is still alive, and the popup reached it. Loading the target in place destroys the
  // opener's document, so neither of these two lines can happen on the default path.
  const popupLeg = probes.find((r) => r.url?.includes('leg=popup&'));
  assert.ok(popupLeg, `the popup reported in: ${paths()}`);
  assert.match(popupLeg.url, /opener=true/, 'the popup has a live `window.opener`');
  // The popup is as powerless as the view that opened it: no require, no process, no module.
  assert.match(popupLeg.url, /node=false/, `the popup was given Node: ${popupLeg.url}`);
  const heard = probes.find((r) => r.url?.includes('leg=opener-heard'));
  assert.ok(heard, `the opener heard the popup's postMessage: ${paths()}`);
  assert.match(heard.url, /handoff-ok/);

  // --- the popup is in the run's own jar, not a second browser -----------------------------------
  assert.match(popupLeg.cookie ?? '', /(^|;\s*)sess=/, `the popup carried the run's session cookie: ${popupLeg.cookie}`);

  // --- and it was born with the same guards ------------------------------------------------------
  const blockedInPopup = lines.filter((l) => l.kind === 'navigation-blocked' && l.view?.startsWith('popup'));
  assert.ok(
    blockedInPopup.some((l) => l.url.startsWith('http://insecure.invalid/')),
    `the popup's own navigation guard refused a non-https target: ${JSON.stringify(lines.filter((l) => l.kind === 'navigation-blocked'))}`,
  );

  // --- and it wears the run's identity, not Electron's -------------------------------------------
  // A popup carrying the machine's own fingerprint beside a pinned opener is a contradiction a
  // vendor can read. The pins reach a context's NEXT document, so this is the popup's second leg.
  const secondLeg = probes.find((r) => r.url?.includes('leg=popup2'));
  assert.ok(secondLeg, `the popup navigated on and reported its fingerprint: ${paths()}`);
  assert.match(
    secondLeg.url,
    /platform=MacIntel/,
    `the popup wears the identity the pass named, not the machine's: ${secondLeg.url}`,
  );

  // --- and the sign-in still completed -----------------------------------------------------------
  assert.equal(api.record.imports.length, 1);
  assert.equal(api.record.imports[0].ofUserId, '778899');
});

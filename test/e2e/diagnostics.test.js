/**
 * THE EVIDENCE RUN. What the sign-in view was allowed to do, written down — and nothing else.
 *
 * On 2026-09-02 OnlyFans asked the operator to confirm his identity, offered a QR code, and the
 * phone that scanned it was answered `Error.Header.NotFound` — raw i18n keys, so the vendor could
 * not even name the state it was in. The app had recorded NOTHING: `setWindowOpenHandler` did not
 * log, a blocked navigation reached only stdout, a denied permission reached nobody. We could not
 * tell a guard of ours from a vendor outage, and all we had was a screenshot.
 *
 * This test drives the real app against a fake OnlyFans that does the three things a vendor handoff
 * does — opens a window, submits a `target=_blank` form, and logs an error — and proves that:
 *
 *   1. every one of them lands in the diagnostic file, with the verdict the app reached;
 *   2. the in-place fallback now carries the POST body and the Referer a real popup would have
 *      carried (asserted on the SERVER, which is the only place that can see them);
 *   3. no secret reaches the file: not the claim, not the pass token, not a cookie value, not the
 *      device token — even though the run handled all four;
 *   4. and with the switch off, no file is written at all.
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
/** Shaped exactly like the device token the app really captures, so the redaction is tested on the real thing. */
const TOKEN_SHAPED = '0123456789abcdef0123456789abcdef01234567';

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
 * The entry page. Three probes, in an order that survives the guard under test: the blocked
 * navigation and the console error run first, because the `window.open` that follows is answered by
 * loading the target IN THIS VIEW — which destroys this document, and with it anything that had not
 * run yet. That destruction is the defect being investigated; here it is simply the test's clock.
 */
const PROBE_ENTRY = `<!doctype html><html><head><meta charset=utf-8><title>OnlyFans</title></head>
<body><h1>probe</h1>
<script>
  // A scheme the app blocks. Silent to this page — preventDefault raises nothing a site can catch.
  try { location.href = 'http://insecure.invalid/blocked-by-the-app'; } catch (e) {}
  // A page error carrying something shaped exactly like a device token.
  console.error('probe failure token ${TOKEN_SHAPED} while starting');
  // And the window a vendor handoff asks for.
  setTimeout(() => { window.open('https://onlyfans.com/opened-by-script?vendor_session=handoff-probe-value', 'vendor', 'width=480,height=640'); }, 400);
</script></body></html>`;

/** The second leg: the shape that carries its session in a POST body rather than a URL. */
const PROBE_FORM = `<!doctype html><html><head><meta charset=utf-8><title>handoff</title></head>
<body>
<form id=f method=POST action="https://onlyfans.com/vendor-handoff" target="_blank">
  <input name="session_ref" value="handoff-probe-value">
</form>
<script>document.getElementById('f').submit();</script>
</body></html>`;

test('the diagnostic records every verdict of the sign-in view, and no secret', async () => {
  const cert = makeCert();
  const claim = 'e2eDiag_0123456789';
  const of = await startFakeOnlyFans({
    key: cert.key,
    cert: cert.cert,
    // `/vendor-handoff` is left to the default page: it IS the sign-in page, so the run finishes.
    pages: { '/': PROBE_ENTRY, '/opened-by-script': PROBE_FORM },
  });
  const api = await startFakeApi({ tunnelPort: null, userAgent: MAC_UA, claim });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyx-e2e-diag-'));
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
        // The switch, pinned at an exact file so the test does not have to find the app's log dir.
        ONLYX_LOGIN_DIAG: diagFile,
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

  // The run still reaches success: recording changes nothing about the sign-in.
  const done = await waitFor(
    () => readLines(stateFile).find((s) => s.phase === 'success' || s.phase === 'error'),
    { exitedRef: () => exited },
  );
  if (!done || done.phase !== 'success') {
    const phases = readLines(stateFile).map((s) => s.phase);
    throw new Error(`expected success; phases were [${phases.join(', ')}]\n--- app logs ---\n${logs.join('').slice(-4000)}`);
  }

  const lines = readLines(diagFile);
  const byKind = (kind) => lines.filter((l) => l.kind === kind);
  const show = () => JSON.stringify(lines.map((l) => `${l.kind} ${l.url ?? l.phase ?? l.permission ?? ''}`), null, 1);

  // --- 1. the header, and the shape of the run ------------------------------------------------
  assert.equal(lines[0]?.kind, 'diagnostic-start', 'the file opens with a header');
  assert.ok(lines[0].chrome, 'the header names the Chromium the vendor actually saw');
  assert.equal(lines[0].popupsAllowed, false, 'popups are off unless asked for');
  const open = byKind('run-open')[0];
  assert.ok(open, `the run was recorded: ${show()}`);
  assert.equal(open.userAgent, MAC_UA, 'the identity presented is recorded — half of any device check');
  assert.equal(open.tunnel, false, 'and which network the sign-in took');
  assert.ok(byKind('state').some((l) => l.phase === 'signin'), 'the phases are in the file');

  // --- 2. a navigation the app blocked, which used to be invisible ------------------------------
  const blocked = byKind('navigation-blocked');
  assert.ok(
    blocked.some((l) => l.url.startsWith('http://insecure.invalid/')),
    `the blocked navigation was recorded: ${show()}`,
  );

  // --- 3. the windows the page asked for, and what the app did with them ------------------------
  const opens = byKind('window-open');
  const scripted = opens.find((l) => l.url.startsWith('https://onlyfans.com/opened-by-script'));
  assert.ok(scripted, `the window.open was recorded: ${show()}`);
  // The URL is recorded with its query NAMES and no values — the app must call the redaction, not
  // merely own one. The "nothing secret" check below is what fails if it stops.
  assert.equal(scripted.url, 'https://onlyfans.com/opened-by-script ?vendor_session');
  assert.equal(scripted.decision, 'load-in-place', 'and the verdict it received');
  assert.equal(scripted.view, 'signin');
  assert.equal(scripted.frameName, 'vendor', 'including the name the page gave the window');

  const posted = opens.find((l) => l.url === 'https://onlyfans.com/vendor-handoff');
  assert.ok(posted, `the target=_blank form was recorded: ${show()}`);
  assert.ok(posted.postBodyParts >= 1, `a handoff that carries its session in a POST body says so: ${JSON.stringify(posted)}`);
  assert.match(posted.postContentType ?? '', /form-urlencoded|form-data/);

  // --- 4. the page's own error, redacted ---------------------------------------------------------
  const errors = byKind('console').filter((l) => l.level === 'error');
  const probe = errors.find((l) => l.text.includes('probe failure token'));
  assert.ok(probe, `the page's console error was captured: ${JSON.stringify(errors)}`);
  assert.match(probe.text, /<redacted:40>/, 'and a token-shaped run in it was masked');

  // --- 5. THE IN-PLACE LOAD NOW CARRIES WHAT A POPUP WOULD HAVE ---------------------------------
  // Asserted on the server, the only place that can see a request body and a Referer. Before this
  // change `loadURL` turned a form POST into a bare GET with no referrer — which is, on its own,
  // enough to make a vendor answer a later lookup "not found".
  const handoff = of.state.requests.filter((r) => r.path === '/vendor-handoff');
  assert.ok(handoff.length >= 1, `the handoff target was reached: ${JSON.stringify(of.state.requests.map((r) => r.method + ' ' + r.path))}`);
  assert.equal(handoff[0].method, 'POST', 'the POST stayed a POST');
  assert.match(handoff[0].body, /session_ref=handoff-probe-value/, 'and it still carried the form field');
  assert.ok(
    (handoff[0].referer ?? '').startsWith('https://onlyfans.com/'),
    `the referrer of the page that opened the window was carried: ${handoff[0].referer}`,
  );

  // --- 6. NOTHING SECRET IS IN THE FILE ----------------------------------------------------------
  const text = fs.readFileSync(diagFile, 'utf8');
  const imported = api.record.imports[0];
  const sess = imported.session.cookies.find((c) => c.name === 'sess').value;
  for (const [what, secret] of [
    ['the link claim', claim],
    ['the pass token', api.token],
    ['the session cookie', sess],
    ['the device token', imported.session.xbc],
    ['the form field value', 'handoff-probe-value'],
  ]) {
    assert.ok(secret && secret.length > 8, `the test's own ${what} is real`);
    assert.ok(!text.includes(secret), `${what} must never reach the diagnostic file`);
  }
});

test('with the switch off, the app writes no diagnostic at all', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyx-e2e-nodiag-'));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache') };
  // Not "set to off" — ABSENT, which is every creator's machine.
  delete env.ONLYX_LOGIN_DIAG;
  const electron = require('electron');
  // No link: `armDiagnostics` runs at ready whether or not a sign-in follows, so an idle launch is
  // the whole probe and costs seconds rather than a full run.
  const child = spawn(electron, ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', appDir], {
    cwd: appDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  after(() => {
    try { child.kill('SIGKILL'); } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  });

  await waitFor(() => logs.join('').includes('[onlyx-login]'), { timeoutMs: 40_000 });
  await sleep(4_000);

  assert.ok(!logs.join('').includes('diagnostics: recording'), 'the app armed a recorder nobody asked for');
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/onlyx-login-signin/.test(entry.name)) found.push(full);
    }
  };
  walk(home);
  assert.deepEqual(found, [], `a diagnostic file was written with the switch off: ${found.join(', ')}`);
});

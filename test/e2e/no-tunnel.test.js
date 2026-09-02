/**
 * The mode production actually ships: the server answers the open with `tunnel: null`
 * (XOF_CONNECT_APP_TUNNEL off, the 2026-09-02 decision) and the app signs the creator in over the
 * machine's OWN network — no forwarder, no loopback listener, no proxy of ours anywhere in the
 * path. app.test.js proves the tunnelled shape still works; without THIS file the shipped mode
 * would be proven by nothing, since a tunnelled run exercises none of the direct-path code.
 *
 * The vendor-facing reason, so nobody "fixes" the mode away: OnlyFans' identity check compares the
 * desktop's network with the phone that scans its QR, and a desktop on the account's residential
 * proxy can never match the creator's wifi. The session made here lands on her IP and is later
 * used by the seat from the account's proxy — that IP jump is a KNOWN, accepted trade-off.
 *
 * How the fake stays hermetic with no tunnel to intercept dialling: the tunnelled test's fake
 * tunnel ignores the CONNECT target and dials the fake OnlyFans itself; here the browser resolves
 * onlyfans.com on its own, so Chromium's `--host-resolver-rules` pins onlyfans.com (host AND port)
 * to the fake server on loopback. TLS still terminates against the fake's onlyfans.com cert, which
 * the app trusts only through ONLYX_TEST_CERT_SHA256 — the same pin the tunnelled test uses.
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

const readStates = (file) => {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

const waitForPhase = async (file, phases, { timeoutMs = 60_000, exitedRef = () => null } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = readStates(file);
    const hit = states.find((s) => phases.includes(s.phase));
    if (hit) return { hit, states };
    if (exitedRef()) return { hit: null, states, exited: exitedRef() };
    await sleep(200);
  }
  return { hit: null, states: readStates(file) };
};

test('offered no tunnel, the app signs in DIRECTLY — no forwarder bound — and still imports the session', async () => {
  const cert = makeCert();
  const claim = 'e2eDirect_0123456789';
  const of = await startFakeOnlyFans({ key: cert.key, cert: cert.cert });
  // No fake tunnel is started AT ALL: if anything in the app still tries to ride one, there is
  // nothing to answer and the run cannot reach success.
  const api = await startFakeApi({ tunnelPort: null, userAgent: MAC_UA, claim });

  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onlyx-e2e-state-')), 'states.jsonl');
  const electron = require('electron');
  const child = spawn(
    electron,
    [
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      // The hermetic stand-in for public DNS: Chromium itself resolves onlyfans.com here, straight
      // to the fake — the app is given no proxy to aim anywhere.
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

  const { hit, states } = await waitForPhase(stateFile, ['success', 'error'], { timeoutMs: 75_000, exitedRef: () => exited });
  const phases = states.map((s) => s.phase);
  if (!hit || hit.phase !== 'success') {
    throw new Error(`expected success; phases were [${phases.join(', ')}]\n--- app logs ---\n${logs.join('').slice(-4000)}`);
  }
  assert.ok(phases.includes('signin'), 'went through signin');
  assert.ok(phases.includes('verifying'), 'went through verifying');

  const logText = logs.join('');
  // The mode was taken, not stumbled into: the app said so, once, and never bound a forwarder.
  assert.match(logText, /no tunnel offered — signing in over this machine's own network/);
  // The forwarder announces every start with this line (tunnel.js); its absence is the app-side
  // proof that NOTHING was bound on loopback — no listener, no per-run proxy credential.
  assert.ok(!logText.includes('forwarder listening'), 'a loopback forwarder was started despite tunnel: null');

  // And the sign-in really happened against the fake OnlyFans, reached directly.
  assert.ok(of.state.meHits >= 2, `the fake OnlyFans was queried for /users/me (guest + signed in); saw ${of.state.meHits}`);
  assert.equal(api.record.open, 1);
  assert.equal(api.record.imports.length, 1);
  const imported = api.record.imports[0];
  assert.equal(imported.ofUserId, '778899');
  assert.equal(imported.username, 'creatorx');
  const names = imported.session.cookies.map((c) => c.name);
  assert.ok(names.includes('sess') && names.includes('auth_id'), `login cookies present: ${names.join(',')}`);
  assert.equal(imported.session.xbc, '0123456789abcdef0123456789abcdef01234567');
});

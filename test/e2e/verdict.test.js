/**
 * THE SEAT'S VERDICT — the three answers `/connect-app/status` can give after the import, and what
 * the creator is shown for each. app.test.js owns the happy one; these are the other two, plus the
 * one that is not an answer at all.
 *
 *   it never comes     the cloud keeps saying `verifying`. The app must keep waiting. This is the
 *                      only setting under which "the app waits for the seat" and "the app declares
 *                      success on its fourth poll" tell different stories: against a fake that
 *                      concedes on poll four, the two are the same run.
 *   it is a refusal    `state: 'failed'` with a `statusReason` — a real ConnectState value
 *                      (connect-app.service.ts) that this suite could not express until now, which
 *                      left the "OnlyX could not use this sign-in" screen dead code in every
 *                      end-to-end run.
 *   the pass runs out  401 on a bearer that is CORRECT. The app never sends a wrong one, so the
 *                      fake's wrong-bearer 401 could never reach the branch that exists for this.
 *
 * The transport here is the shipped one: no tunnel offered, onlyfans.com pinned to the fake with
 * Chromium's --host-resolver-rules (no-tunnel.test.js explains why that is the production default).
 * What is under test is what the app does with an ANSWER, which is the same on either transport.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { createRequire } from 'node:module';

import { startFakeApi, startFakeOnlyFans } from './fakes.js';

const require = createRequire(import.meta.url);
const appDir = path.resolve(fileURLToPath(import.meta.url), '../../..');
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
/** main.js's STATUS_POLL_MS. Windows below are stated in polls and converted with this. */
const POLL_MS = 3_000;

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

/**
 * A real run, up to the point where the polling starts: the fake OnlyFans, the fake API answering
 * `tunnel: null`, and the app opened on a link. Cleanup is registered against the test that asked
 * for it, so each of these owns exactly one Electron process for exactly as long as it needs it.
 */
const launch = async (t, { claim, ...apiOptions }) => {
  const cert = makeCert();
  const of = await startFakeOnlyFans({ key: cert.key, cert: cert.cert });
  const api = await startFakeApi({ tunnelPort: null, userAgent: MAC_UA, claim, ...apiOptions });
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onlyx-e2e-state-')), 'states.jsonl');
  const child = spawn(
    require('electron'),
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

  t.after(async () => {
    try { child.kill('SIGKILL'); } catch {}
    await Promise.all([of.close(), api.close()]);
    fs.rmSync(cert.dir, { recursive: true, force: true });
  });

  return { api, stateFile, logs, exitedRef: () => exited };
};

test('while the cloud keeps saying `verifying` the app shows no success — and when the seat refuses, it says so, in the seat’s words', async (t) => {
  const REASON = 'signed out of OnlyFans';
  /** Polls of `verifying` to sit through before the refusal. main.js's own poll count is 4. */
  const HOLD_POLLS = 6;
  const { api, stateFile, logs, exitedRef } = await launch(t, {
    claim: 'e2eVerdict_0123456789',
    // A cloud that NEVER concedes...
    connectAfter: Infinity,
    // ...and then refuses, with the sentence the server would have stored about her account.
    failAfter: HOLD_POLLS + 1,
    statusReason: REASON,
  });

  // The import landed and the polling has started.
  const { hit: verifying } = await waitForPhase(stateFile, ['verifying', 'success', 'error'], { timeoutMs: 75_000, exitedRef });
  assert.equal(
    verifying?.phase,
    'verifying',
    `the run never reached verifying: ${readStates(stateFile).map((s) => s.phase).join(', ')}\n--- app logs ---\n${logs.join('').slice(-4000)}`,
  );

  // THE GATE, and the reason this file exists. Nothing on this cloud will ever say `connected`, so
  // any success screen inside this window came from the app's own arithmetic — a count of polls, an
  // import that was ACCEPTED, a timer. The window is six polls, half again as long as the four-poll
  // hold app.test.js runs against, and it is watched continuously rather than sampled at the end.
  const windowEnds = Date.now() + (HOLD_POLLS + 1) * POLL_MS + 10_000;
  while (api.record.statusHits < HOLD_POLLS && Date.now() < windowEnds) {
    const painted = readStates(stateFile).find((s) => s.phase === 'success' || s.phase === 'error');
    assert.equal(
      painted,
      undefined,
      `the app left the waiting screen while the cloud was still verifying (poll ${api.record.statusHits}): `
        + `${JSON.stringify(painted)}. Success is the seat's verdict to give, not the app's to decide.`,
    );
    if (exitedRef()) throw new Error(`the app exited while verifying: ${JSON.stringify(exitedRef())}`);
    await sleep(200);
  }
  assert.ok(
    api.record.statusHits >= HOLD_POLLS,
    `the app stopped polling after ${api.record.statusHits} of ${HOLD_POLLS} status calls — it is no longer asking the seat anything`,
  );

  // THE REFUSAL. The state carries what the screen renders (ui.js paints state.title and
  // state.detail), so this is the whole hand-off: the seat's verdict -> messages.js -> her screen.
  const { hit: refused, states } = await waitForPhase(stateFile, ['error', 'success'], { timeoutMs: 30_000, exitedRef });
  assert.equal(
    refused?.phase,
    'error',
    `a 'failed' verdict left the app on ${readStates(stateFile).at(-1)?.phase ?? 'nothing'} — the creator is watching `
      + `a spinner that will never stop.\n--- app logs ---\n${logs.join('').slice(-4000)}`,
  );
  assert.equal(refused.title, 'OnlyX could not use this sign-in');
  assert.match(
    refused.detail,
    new RegExp(REASON),
    `the seat's own reason never reached her: ${refused.detail}`,
  );
  assert.match(refused.detail, /Open a new link and sign in again/);
  assert.equal(api.record.failedFrom, HOLD_POLLS + 1, 'the fake refused on a different poll than it was asked to');
  assert.equal(api.record.connectedFrom, null, 'this cloud was never supposed to answer `connected`');
  // And it stopped asking: a run the app has ended is ended.
  const pollsAtRefusal = api.record.statusHits;
  await sleep(POLL_MS + 1_000);
  assert.equal(api.record.statusHits, pollsAtRefusal, 'the app kept polling after the seat had refused');
  assert.equal(states.at(-1).phase, 'error', 'the refusal was painted over');
});

test('the pass running out mid-verify leaves her told, not spinning', async (t) => {
  const { stateFile, logs, exitedRef, api } = await launch(t, {
    claim: 'e2eExpired_0123456789',
    // The first poll after the import answers `verifying`; the second answers 401 to the same,
    // correct, bearer — the pass expired while the seat was still working.
    unauthorizedAfter: 2,
    connectAfter: Infinity,
  });

  const { hit } = await waitForPhase(stateFile, ['error', 'success'], { timeoutMs: 75_000, exitedRef });
  assert.equal(
    hit?.phase,
    'error',
    `the pass expired mid-verify and the app never said so: ${readStates(stateFile).map((s) => s.phase).join(', ')}\n`
      + `--- app logs ---\n${logs.join('').slice(-4000)}`,
  );
  // Not "something went wrong": the sign-in itself was received, and the screen says exactly that.
  assert.equal(hit.title, 'Still connecting');
  assert.match(hit.detail, /Your sign-in was received/);
  assert.equal(api.record.unauthorizedFrom, 2, 'the fake refused the pass on a different poll than it was asked to');

  // And the polling stopped: an expired pass will not become a valid one, and a run that keeps
  // asking is a run that never ends.
  const pollsAtError = api.record.statusHits;
  await sleep(POLL_MS + 1_000);
  assert.equal(api.record.statusHits, pollsAtError, 'the app kept polling with a pass the server had refused');
});

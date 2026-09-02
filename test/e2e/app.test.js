/**
 * The whole app, end to end: the real Electron binary, opened with a deep link, driven against a
 * fake OnlyFans / tunnel / API until it reaches the success screen — and then the assertions that
 * the session it handed over was the signed-in one.
 *
 * Needs a display (Xvfb) and the platform libraries Chromium wants; the Dockerfile beside this file
 * provides both. Run it with `npm run test:e2e` inside that image.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';

import { startFakeApi, startFakeOnlyFans, startFakeTunnel } from './fakes.js';

const require = createRequire(import.meta.url);
const appDir = path.resolve(fileURLToPath(import.meta.url), '../../..');
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
/** Status polls the fake refuses before it answers `connected`. Named once: see THE GATE below. */
const CONNECT_AFTER = 4;
/** main.js's STATUS_POLL_MS — how long "after the app should have finished" is. */
const POLL_MS = 3_000;

/** A self-signed cert for onlyfans.com, and the base64 SHA-256 of its DER — what the app is told to trust. */
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

test(`a link opens, signs in, imports the session, and reaches success${process.env.ONLYX_TEST_PACKAGED_BIN ? ' (PACKAGED build)' : ''}`, async () => {
  const cert = makeCert();
  const claim = 'e2eClaim_0123456789';
  const of = await startFakeOnlyFans({ key: cert.key, cert: cert.cert });
  const tunnel = await startFakeTunnel({ onlyfansPort: of.port });
  // FOUR polls before the fake says `connected`, not the default two. The success screen is what
  // tells a creator she can walk away, and the only thing that may put it on screen is the SEAT's
  // verdict — the API answers `connected` only once the seat has captured a jar of its own after
  // the import (connectState in connect-app.service.ts). An app that treated its own import being
  // ACCEPTED as success would show it immediately, and against `connectAfter: 2` that mistake is
  // one poll away from looking correct; three refusals put it out of reach.
  // What no concession point can separate is an app that succeeds on its own COUNT of polls — see
  // THE GATE below, and verdict.test.js, which runs this same flow against a cloud that never
  // concedes at all.
  const api = await startFakeApi({ tunnelPort: tunnel.port, userAgent: MAC_UA, claim, connectAfter: CONNECT_AFTER });

  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onlyx-e2e-state-')), 'states.jsonl');
  // ONLYX_TEST_PACKAGED_BIN points at a packed build's executable. Without it this drives the
  // source tree, which is the same code but NOT the same loading: a packaged app resolves its ESM
  // entry and its CommonJS `ws` dependency from inside an asar archive, and a failure there is a
  // silent no-window boot that no source-tree run can catch.
  const packagedBin = process.env.ONLYX_TEST_PACKAGED_BIN || null;
  const electron = packagedBin ?? require('electron'); // resolves to the binary path string
  const child = spawn(
    electron,
    packagedBin
      ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `onlyx-connect://open?c=${claim}`]
      : ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', appDir, `onlyx-connect://open?c=${claim}`],
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
  const tap = (stream) => (d) => {
    const text = d.toString();
    logs.push(text);
    for (const line of text.split('\n')) if (line.trim()) console.log(`  [app] ${line}`);
  };
  child.stdout.on('data', tap(child.stdout));
  child.stderr.on('data', tap(child.stderr));
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; console.log(`  [app] exited code=${code} signal=${signal}`); });

  after(async () => {
    try { child.kill('SIGKILL'); } catch {}
    await Promise.all([of.close(), tunnel.close(), api.close()]);
    fs.rmSync(cert.dir, { recursive: true, force: true });
  });

  const { hit, states } = await waitForPhase(stateFile, ['success', 'error'], { timeoutMs: 75_000, exitedRef: () => exited });
  const phases = states.map((s) => s.phase);
  if (!hit || hit.phase !== 'success') {
    throw new Error(`expected success; phases were [${phases.join(', ')}]\n--- app logs ---\n${logs.join('').slice(-4000)}`);
  }

  // The path the run actually took.
  assert.ok(phases.includes('opening'), 'went through opening');
  assert.ok(phases.includes('signin'), 'went through signin');
  assert.ok(phases.includes('verifying'), 'went through verifying');
  assert.equal(hit.phase, 'success');

  // THE GATE. `success` is reached only on the seat's verdict, never on the import being accepted.
  //
  // Asserted against the FAKE'S OWN RECORD of what it answered and when, not against a phase list
  // alone: `phases.includes('verifying')` above is true of an app that shows verifying for one
  // frame and then succeeds on the very next answer, whatever that answer says.
  //
  // WHAT THIS RUN CANNOT DECIDE, so nobody rests on it: whether the app waited for the seat or
  // simply counted to four. This cloud concedes on poll four, so an app that declared success on
  // its OWN fourth poll, whatever the answer said, produces every number below unchanged — that is
  // measured, not feared. The run that separates them is the one whose cloud never concedes at
  // all, and it lives in verdict.test.js.
  assert.equal(
    api.record.connectedFrom,
    CONNECT_AFTER,
    `the app stopped asking before the seat had answered: the fake first said 'connected' on poll `
      + `${api.record.connectedFrom} of an expected ${CONNECT_AFTER}, and the success screen was already up`,
  );
  // It stopped AT the verdict, in both directions — not a poll early (success nobody gave it) and
  // not a poll late (a verdict it did not act on). A relationship between two of the fake's own
  // counters, with no number in it for an app counting polls to agree with.
  assert.equal(
    api.record.statusHits,
    api.record.connectedFrom,
    `the app made ${api.record.statusHits} status calls for a verdict that arrived on call ${api.record.connectedFrom}`,
  );
  const captured = states.findIndex((s) => s.phase === 'captured');
  assert.ok(captured >= 0, 'the app never recorded capturing the session');
  const verifyingAfterImport = states.slice(captured).filter((s) => s.phase === 'verifying');
  assert.ok(
    verifyingAfterImport.length >= CONNECT_AFTER - 1,
    `the app succeeded before the seat confirmed: only ${verifyingAfterImport.length} verifying state(s) between the import and success`,
  );

  // ...AND NOTHING PAINTED OVER IT. `states` was read the instant success appeared, so on its own
  // it cannot answer this: at that moment nothing later has been written yet, and the app is
  // SIGKILLed in `after()` before anything later could be read. So read the file again, after more
  // than a poll interval — long enough for a late answer, a stray timer or an update screen to have
  // put something else in front of a creator who has been told she may walk away.
  assert.equal(states.at(-1)?.phase, 'success', `success was not the final state: ${phases.join(', ')}`);
  await sleep(POLL_MS + 1_000);
  const settled = readStates(stateFile);
  assert.deepEqual(
    settled.slice(settled.findIndex((s) => s.phase === 'success')).map((s) => s.phase),
    ['success'],
    `the success screen did not survive: phases were [${settled.map((s) => s.phase).join(', ')}]`,
  );

  // The pass was opened once, and the tunnel carried the bearer token.
  assert.equal(api.record.open, 1);
  assert.ok(tunnel.seen.upgrades >= 1, 'the tunnel was used');
  assert.ok(tunnel.seen.tokens.every((t) => t === `Bearer ${api.token}`), 'every stream carried the pass token');

  // The imported session was the signed-in one: sess + auth_id present, and the right user.
  assert.equal(api.record.imports.length, 1);
  const imported = api.record.imports[0];
  assert.equal(imported.ofUserId, '778899');
  assert.equal(imported.username, 'creatorx');
  const names = imported.session.cookies.map((c) => c.name);
  assert.ok(names.includes('sess') && names.includes('auth_id'), `login cookies present: ${names.join(',')}`);
  assert.ok(!names.includes('__cf_bm'), 'cloudflare cookies stripped');
  assert.equal(imported.session.xbc, '0123456789abcdef0123456789abcdef01234567');
  assert.match(imported.session.cookieHeader, /sess=/);
});

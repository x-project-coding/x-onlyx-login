/**
 * THE APP TOLD TO PRESENT ITS OWN MACHINE, driven end to end with the real Electron binary — and
 * checked on BOTH sides at once, because a device claim is only a lie relative to the rest of it.
 *
 *   the wire   the request headers the fake OnlyFans received: user-agent, sec-ch-ua,
 *              sec-ch-ua-full-version-list, sec-ch-ua-platform, accept-language
 *   the page   what the page itself reports back to /probe: whether the pins were defined on
 *              Navigator.prototype, what getParameter answers before the debug extension is
 *              obtained, what languages the engine ended up with
 *
 * Every assertion below is one that FAILS in seat mode — no-tunnel.test.js asserts the same fields
 * with the opposite values on the same fake — so this file cannot pass by measuring nothing.
 *
 * Needs a display (Xvfb) and Chromium's libraries; the Dockerfile beside this file provides both.
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

const waitFor = async (predicate, { timeoutMs = 75_000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = predicate();
    if (hit) return hit;
    await sleep(200);
  }
  return null;
};

test('told `source: native`, the app presents this machine — no pins, no borrowed version, no invented language', async () => {
  const cert = makeCert();
  const claim = 'e2eNative_0123456789';
  const of = await startFakeOnlyFans({ key: cert.key, cert: cert.cert });
  const api = await startFakeApi({
    tunnelPort: null,
    // The exact shape x-onlyfans' connect-app service sends in native mode: an EMPTY user agent
    // (never absent — session.setUserAgent(undefined) throws and kills the run), and null for
    // every claim about the device.
    userAgent: '',
    identity: {
      source: 'native',
      userAgent: '',
      acceptLanguage: null,
      platform: null,
      userAgentMetadata: null,
      initScript: null,
      timezone: null,
    },
    claim,
  });

  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onlyx-e2e-state-')), 'states.jsonl');
  const electron = require('electron');
  const child = spawn(
    electron,
    [
      // `--enable-unsafe-swiftshader` beside `--disable-gpu`: with neither there is NO WebGL
      // context in this container, `getParameter` is never reached, and the assertions below
      // about the renderer pin pass on `undefined` — a guard that is void exactly where it
      // matters. Measured: without it `probe.webgl` came back null in both directions.
      '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
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
  after(async () => {
    try { child.kill('SIGKILL'); } catch {}
    await Promise.all([of.close(), api.close()]);
    fs.rmSync(cert.dir, { recursive: true, force: true });
  });

  const hit = await waitFor(() => readStates(stateFile).find((s) => ['success', 'error'].includes(s.phase)));
  if (!hit || hit.phase !== 'success') {
    const phases = readStates(stateFile).map((s) => s.phase);
    throw new Error(`expected success; phases were [${phases.join(', ')}]\n--- app logs ---\n${logs.join('').slice(-4000)}`);
  }
  // The whole flow still works: the point is an honest identity, not a broken sign-in.
  assert.equal(api.record.imports.length, 1);
  assert.equal(api.record.imports[0].ofUserId, '778899');

  const probe = await waitFor(() => of.state.probe);
  assert.ok(probe, 'the page never reported what it was; the identity cannot be checked');

  // --- the page ---------------------------------------------------------------------------------
  // 'engine' means the getter is the engine's own — `[native code]` — where a pin's is an arrow
  // function. The property is an own accessor of Navigator.prototype in a real browser TOO
  // (measured), so its presence proves nothing; this reading is machine-independent, where
  // `hardwareConcurrency !== 8` would pass or fail on the size of whatever box the test runs on.
  assert.deepEqual(probe.descriptors, { hardwareConcurrency: 'engine', deviceMemory: 'engine', platform: 'engine' });
  // Real Chrome answers 37445/37446 with null until WEBGL_debug_renderer_info has been obtained.
  // A patched getParameter answers anyway, which is a one-line detector that never looks at the
  // GPU string at all.
  // The probe must actually have had a context, or every renderer assertion below is void.
  assert.ok(probe.webgl && !probe.webgl.error, `no WebGL context to judge: ${JSON.stringify(probe.webgl)}`);
  assert.equal(probe.webgl?.vendorUnasked ?? null, null, 'getParameter answered the unmasked vendor unasked');
  assert.equal(probe.webgl?.rendererUnasked ?? null, null, 'getParameter answered the unmasked renderer unasked');
  assert.match(String(probe.webgl?.getParameterSource), /\[native code\]/, "getParameter is not the engine's");
  // Passing 'en-US,en;q=0.9' through the CDP acceptLanguage parameter makes navigator.languages
  // read ["en-US","en;q=0.9"] — a language tag no browser has. Native passes nothing.
  for (const lang of probe.languages ?? []) assert.ok(!/;q=/.test(lang), `navigator.languages carries ${lang}`);
  // Client hints present, not blanked: an override with a UA and no metadata empties this list and
  // drops every Sec-CH-UA-* header, which is louder than the token it was removing.
  assert.ok(Array.isArray(probe.brands) && probe.brands.length > 0, 'userAgentData.brands was blanked');
  assert.ok(!probe.brands.some((b) => b.brand === 'Electron'), 'an Electron brand reached the page');
  assert.ok(probe.uadPlatform, 'userAgentData.platform was blanked');
  assert.ok(!/Electron\//.test(probe.userAgent), `navigator.userAgent still names Electron: ${probe.userAgent}`);

  // --- the wire ---------------------------------------------------------------------------------
  const wire = of.state.requests.filter((r) => r.headers['user-agent']);
  assert.ok(wire.length >= 2, 'the fake saw too few requests to judge');
  const ua = wire.at(-1).headers['user-agent'];
  assert.ok(!/Electron\//.test(ua), `the wire User-Agent names Electron: ${ua}`);
  assert.ok(!/OnlyX/i.test(ua), `the wire User-Agent names the app: ${ua}`);
  assert.equal(ua, probe.userAgent, 'the page and the wire disagree about which browser this is');
  // The session UA reaches every request, the page AND (the half a page override never does) any
  // service worker — so there is one string, not two.

  // ONE version, everywhere, and reduced the way every browser reduces it. This is the shape the
  // seat's profile could not hold: its UA said Chrome 151 while Sec-CH-UA-Full-Version-List still
  // answered Chromium 152, because the profile sets the deprecated `fullVersion` and never
  // `fullVersionList`.
  const major = ua.match(/Chrome\/(\d+)\.0\.0\.0 Safari/)?.[1];
  assert.ok(major, `the User-Agent is not a reduced Chrome version: ${ua}`);
  const hinted = wire.map((r) => r.headers['sec-ch-ua']).filter(Boolean);
  assert.ok(hinted.length > 0, 'no Sec-CH-UA header was ever sent — the hints were blanked');
  assert.match(hinted.at(-1), new RegExp(`"Chromium";v="${major}"`), `sec-ch-ua disagrees with the UA: ${hinted.at(-1)}`);
  assert.ok(!/Electron/.test(hinted.at(-1)), `sec-ch-ua names Electron: ${hinted.at(-1)}`);
  // THE HIGH-ENTROPY HALF IS READ FROM THE PAGE, not the wire, and deliberately: Chrome will not
  // persist an `Accept-CH` for an origin whose certificate it had to be told to accept, so the
  // fake never sees `Sec-CH-UA-Full-Version-List` however loudly it asks. The page's own
  // `getHighEntropyValues` is the same data and is what a fingerprinter calls anyway.
  assert.ok(probe.high && !probe.high.error, `the page could not read its own hints: ${JSON.stringify(probe.high)}`);
  // ONE version across the two fields that disagreed on the seat's profile: it set the deprecated
  // `fullVersion` and never `fullVersionList`, so `uaFullVersion` said 151 while the list said 152.
  assert.match(String(probe.high.uaFullVersion ?? ''), new RegExp(`^${major}\\.`), JSON.stringify(probe.high));
  const chromium = (probe.high.fullVersionList ?? []).find((b) => b.brand === 'Chromium');
  assert.ok(chromium, `no Chromium in the full version list: ${JSON.stringify(probe.high.fullVersionList)}`);
  assert.match(chromium.version, new RegExp(`^${major}\\.`), `the full version list disagrees with the UA: ${chromium.version}`);
  assert.equal(chromium.version, probe.high.uaFullVersion, 'two fields of one API name two versions');

  const platformHint = wire.map((r) => r.headers['sec-ch-ua-platform']).filter(Boolean).at(-1);
  assert.ok(platformHint && platformHint !== '""', `sec-ch-ua-platform was blank: ${platformHint}`);
  assert.equal(platformHint.replaceAll('"', ''), probe.uadPlatform, 'the wire and the page name different platforms');
  // The seat's language string never reaches the wire in this mode; the engine's own does, and it
  // is well formed.
  const acceptLanguage = wire.map((r) => r.headers['accept-language']).filter(Boolean).at(-1);
  assert.ok(!/;q=[\d.]+;q=/.test(String(acceptLanguage)), `a doubled q-value went out: ${acceptLanguage}`);

  // And the app said which identity it took, once, so a support log can answer the question.
  assert.match(logs.join(''), /this machine identity/);
  assert.match(logs.join(''), /native identity: Mozilla/);
  assert.ok(!/native identity:.*Electron/.test(logs.join('')), 'the app logged an uncleaned identity');
});

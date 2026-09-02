/**
 * THE HONEST IDENTITY, and the shapes it must refuse to build.
 *
 * Every expectation here is anchored to a reading taken with the real engine this app ships
 * (Electron 44 / Chrome 152, under Xvfb, test/e2e/identity-probe.cjs, 2026-09-02) rather than to a
 * guess about what Chrome sends:
 *
 *   this engine, untouched   UA `...Chrome/152.0.7977.65 Electron/44.1.1 Safari/537.36` — an
 *                            UNREDUCED version, which no browser sends, plus the runtime's name
 *   its client hints         [{Not?A_Brand,24},{Chromium,152}], real platform, real
 *                            platformVersion — a coherent plain Chromium, already true, and the
 *                            reason nothing here rebuilds them
 *   the seat's identity      UA Chrome/151.0.0.0 while `fullVersionList` still said Chromium
 *                            152.0.7977.65 — the profile sets the deprecated `fullVersion` only
 *
 * The end-to-end half of this lives in test/e2e/native-identity.test.js, which drives the real app
 * and reads the wire and the page; this file is the string surgery, which is where a regex is
 * cheapest to get wrong.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { APP_CAPS, cleanUserAgent, isNative } from '../src/native-identity.js';

/** What Electron 44 reports for this app, measured. */
const ELECTRON_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.65 Electron/44.1.1 Safari/537.36';
/**
 * What the PACKAGED app really sends, read off the wire in the e2e run: Electron puts the app's own
 * product token in front of Chrome. Kept verbatim rather than tidied — the spaceless `OnlyXLogin`
 * is what `app.getName()` produced, and a test written from the tidy guess would not have covered
 * it.
 */
const NAMED_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) OnlyXLogin/1.1.0 Chrome/152.0.7977.65 Electron/44.1.1 Safari/537.36';
/** And the same shape with a SPACE in the product name, which `productName` would give it. */
const SPACED_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) OnlyX Login/1.2.0 Chrome/152.0.7977.65 Electron/44.1.1 Safari/537.36';

test('the build declares exactly the capability the server gates the honest identity on', () => {
  assert.deepEqual(APP_CAPS, ['nativeIdentity']);
});

test('only an explicit native source counts — anything else wears what it was sent', () => {
  assert.equal(isNative({ source: 'native' }), true);
  for (const identity of [null, undefined, {}, { source: 'seat' }, { source: 'NATIVE' }, { source: true }]) {
    assert.equal(isNative(identity), false, JSON.stringify(identity));
  }
});

test('cleaning removes the app, the runtime, and the version no browser sends', () => {
  assert.equal(
    cleanUserAgent(ELECTRON_UA),
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  );
  assert.equal(
    cleanUserAgent(NAMED_UA),
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  );
  // The app's own name, spaces and all. Matched as "everything up to Chrome/" precisely because
  // `OnlyX Login/1.2.0` is not one whitespace-free token and a token match would leave it behind.
  assert.equal(
    cleanUserAgent(SPACED_UA),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  );
  for (const cleaned of [cleanUserAgent(ELECTRON_UA), cleanUserAgent(NAMED_UA), cleanUserAgent(SPACED_UA)]) {
    assert.ok(!/Electron/i.test(cleaned), 'the Electron token survived');
    assert.ok(!/OnlyX/i.test(cleaned), 'the app name survived');
    assert.ok(!/ {2}/.test(cleaned), 'cleaning left a double space, which is itself a tell');
    // The build number belongs in Sec-CH-UA-Full-Version-List, where the engine still puts it —
    // not in the User-Agent, where every browser has sent <major>.0.0.0 since the UA reduction.
    assert.match(cleaned, /Chrome\/152\.0\.0\.0 Safari\/537\.36$/);
  }
  // The platform is NOT touched: this is the machine's own string, not a disguise.
  assert.match(cleanUserAgent(SPACED_UA), /Macintosh; Intel Mac OS X 10_15_7/);
  assert.match(cleanUserAgent(NAMED_UA), /X11; Linux x86_64/);
});

test('an already-reduced user agent survives the clean unchanged', () => {
  // A build whose UA carries no app token and an already-frozen version must come out byte for
  // byte the same — a regex that "fixes" a correct string is how a clean introduces a tell.
  const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
  assert.equal(cleanUserAgent(chrome), chrome);
});

test('a user agent with no Chrome token is refused rather than mangled', () => {
  for (const ua of [null, undefined, '', 'Mozilla/5.0 (Macintosh) Safari/537.36', 42]) {
    assert.equal(cleanUserAgent(ua), null, String(ua));
  }
});

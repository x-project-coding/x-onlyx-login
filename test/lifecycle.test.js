/**
 * What main.js WIRES UP as it loads — asserted on every platform, including the one this suite can
 * never actually run on.
 *
 * The close chain ends in `window-all-closed -> app.quit()`, and that handler exists to override an
 * Electron default that only applies on macOS: there, an app OUTLIVES its last window. Every test
 * that drives the real binary (close.test.js) runs on Linux — CI is ubuntu-latest, the e2e image is
 * node:22-bookworm — where Electron quits by itself, so none of them can tell the override from its
 * absence: delete the handler and they all still pass.
 *
 * So the handler is asserted here instead, where the platform is an input. `src/main.js` is imported
 * by a plain Node process with the `electron` module swapped for a stub (test/fixtures/), once per
 * platform, and the handler it registered is CALLED. What that proves is that neither the
 * registration nor the handler's body is conditional on the platform — which is precisely the
 * regression to fear, since the shape everyone knows is `if (process.platform !== 'darwin')`.
 *
 * What it does NOT prove, and cannot on Linux: that real Electron on real macOS behaves as
 * documented. That is Electron's contract, not this app's; what is ours is that we call `quit()`
 * there too, and that is what is checked below. The stub also stops short of `ready` — the window,
 * the menu and the updater all want a real Chromium — so this file is about wiring, and
 * close.test.js remains the proof that the button at the other end of it works.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

// Both must happen before src/main.js is first imported: the hooks point its `electron` import at
// the stub, and the stub is what this file reads back.
register('./fixtures/electron-hooks.js', import.meta.url);
const { record } = await import('./fixtures/electron-stub.js');

const MAIN = new URL('../src/main.js', import.meta.url).href;
const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');

/**
 * Run `body` as if this machine were `platform` — the import AND the handler call, since the shape
 * to catch (`if (process.platform !== 'darwin')`) reads the platform when it RUNS, not when it is
 * registered. An earlier draft restored the real platform before calling the handler and passed
 * happily with that very line in place.
 */
const underPlatform = async (platform, body) => {
  Object.defineProperty(process, 'platform', { ...REAL_PLATFORM, value: platform });
  try {
    return await body();
  } finally {
    Object.defineProperty(process, 'platform', REAL_PLATFORM);
  }
};

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`on ${platform}, closing the last window quits the app`, async () => {
    await underPlatform(platform, async () => {
      record.reset();
      // The query string gives each platform its own module instance — a second plain `import` of
      // the same URL would be answered from the cache and would register nothing.
      await import(`${MAIN}?platform=${platform}`);

      const windowAllClosed = record.handlerFor('window-all-closed');
      assert.equal(
        typeof windowAllClosed,
        'function',
        `main.js registered no window-all-closed handler on ${platform}: with none, macOS keeps the `
          + `app alive after the creator clicks Close (events registered: ${[...record.handlers.keys()].join(', ') || 'none'})`,
      );
      assert.equal(record.calls.quit, 0, 'main.js quit the app while merely loading');

      windowAllClosed();

      assert.equal(
        record.calls.quit,
        1,
        `the last window closed on ${platform} and the app did not quit. On darwin that is the `
          + 'Electron default reasserting itself — the handler must call app.quit() on every platform, '
          + 'not only where the platform is not darwin.',
      );
    });
  });
}

/**
 * "You can close this window" has to be true.
 *
 * The success screen is the last thing a creator sees, and its only action is a Close button. What
 * that button does spans four files — ui.js's handler, preload.cjs's IPC bridge, main.js's action
 * map, and the `window-all-closed` handler that turns a closed window into a quit — and NOTHING
 * asserted any of it. app.test.js reaches `success` and then SIGKILLs the app, so a build whose
 * Close button did nothing at all (a renamed IPC channel, a dropped `window-all-closed`, an
 * `activate` handler added back) would have passed every suite while leaving her clicking a dead
 * button.
 *
 * The macOS half matters most and is the half a reviewer is most likely to "fix": Electron's
 * default is for an app to OUTLIVE its last window on darwin. main.js overrides that on purpose.
 * This test is what makes that override load-bearing rather than decorative.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const appDir = path.resolve(fileURLToPath(import.meta.url), '../../..');

test('the success screen offers one button, it says Close, and clicking it quits the app', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onlyx-close-')), 'report.json');
  const probe = path.join(appDir, 'test', 'e2e', 'close-probe.cjs');
  const electron = require('electron');

  execFileSync(electron, ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', probe], {
    cwd: appDir,
    env: { ...process.env, ONLYX_CLOSE_REPORT: out },
    stdio: 'pipe',
    timeout: 90_000,
  });

  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(report.windowCreated, true, `no window: ${JSON.stringify(report)}`);
  assert.equal(report.headerFound, true, `no header view: ${JSON.stringify(report)}`);
  // The screen itself, so a report of "quit: true" cannot come from some other screen entirely.
  assert.match(report.title, /connected/i, `not the success screen: ${JSON.stringify(report)}`);
  assert.match(report.text, /close this window/i, `the copy no longer promises a close: ${JSON.stringify(report)}`);
  assert.deepEqual(
    report.actions,
    ['Close'],
    `the success screen's actions are not exactly one Close button: ${JSON.stringify(report.actions)}`,
  );
  assert.equal(report.buttonFound, true, 'no button on the success screen matched /close/i');
  assert.equal(report.clicked, true, 'the click was never dispatched');

  // THE PROPERTY. Not "the window went away" — the APP ended, which is what the copy promises and
  // what `window-all-closed -> app.quit()` exists to deliver on every platform.
  assert.equal(report.quit, true, `Close did not quit the app: ${JSON.stringify(report)}`);
  assert.equal(report.windowsAfterClose, 0, `a window survived the quit: ${JSON.stringify(report)}`);
});

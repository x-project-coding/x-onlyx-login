/**
 * Launched from the icon — no deep link — the app must put a visible window on screen.
 *
 * v1.0.0 did not: the window was created with `show: false` and shown on 'ready-to-show', an event
 * of the window's OWN webContents — which never loads anything, all content being child
 * WebContentsViews — so the event never fired, and the only other show path (focusWindow) runs only
 * for a link. A creator who opened the installed app saw nothing at all. Every other e2e launches
 * WITH a link, which is why none of them caught it; this is the test that fails on that build.
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

test('launched with no link, a visible window shows the waiting screen', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onlyx-nolink-')), 'report.json');
  const probe = path.join(appDir, 'test', 'e2e', 'no-link-probe.cjs');
  const electron = require('electron');

  execFileSync(electron, ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', probe], {
    cwd: appDir,
    env: { ...process.env, ONLYX_NOLINK_REPORT: out },
    stdio: 'pipe',
    timeout: 60_000,
  });

  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(report.windowCreated, true, `no window was created: ${JSON.stringify(report)}`);
  assert.equal(report.visible, true, `the window never became visible — the creator sees nothing: ${JSON.stringify(report)}`);
  // And it is the waiting screen, not a blank canvas: the idle card rendered its copy.
  assert.equal(report.mode, 'full', `the header page is not in full mode: ${JSON.stringify(report)}`);
  assert.match(report.idleTitle, /waiting/i, `the idle title does not read as a waiting state: ${JSON.stringify(report.idleTitle)}`);
  assert.ok(report.idleText.length > 0, 'the idle screen rendered no body text');
});

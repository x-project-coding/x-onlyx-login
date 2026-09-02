/**
 * The app's own chrome, in the product's identity.
 *
 * Branding is a thing that breaks silently: a bundled font that the page's CSP refuses on a
 * `file://` origin renders in Helvetica and nothing errors, and a packaged app resolves its assets
 * out of an asar archive rather than a directory — so "it looked right on my machine" is not
 * evidence. This loads the real UI page the way the app does and asserts the typeface actually
 * arrived and the brand colour is the one on `app.onlyx.ai`.
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

/** OnlyX's accent, sampled from the OnlyFans mark — the same value app.onlyx.ai uses. */
const BRAND = '#00AEEF';

test('the UI page loads the bundled typeface and the brand accent', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onlyx-brand-')), 'report.json');
  const probe = path.join(appDir, 'test', 'e2e', 'branding-probe.cjs');
  const electron = require('electron');

  execFileSync(electron, ['--no-sandbox', '--disable-gpu', probe], {
    cwd: appDir,
    env: { ...process.env, ONLYX_BRAND_REPORT: out },
    stdio: 'pipe',
    timeout: 60_000,
  });

  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  // The font: `document.fonts.check` is false until the face has actually loaded, so a CSP refusal
  // or a bad path fails here rather than silently falling back to the system sans.
  assert.equal(report.fontLoaded, true, `Public Sans did not load: ${JSON.stringify(report)}`);
  assert.match(report.bodyFont, /Public Sans/, 'the body is not set in the product typeface');
  assert.equal(report.brand.toUpperCase(), BRAND, 'the accent is not the OnlyX brand blue');
  // The mark and the wordmark are what a creator recognises the app by.
  assert.equal(report.hasMark, true, 'the OnlyX mark is not rendered');
  assert.match(report.title, /OnlyX Login/);
});

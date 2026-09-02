/**
 * The full-screen card's geometry, measured — because v1.0.1 shipped a layout bug every suite
 * was blind to.
 *
 * ui.js swaps `#full-icon`'s whole className per state, and the idle screen's `mark lg` did not
 * keep `.icon` — the class the centring margin lived on — so the installed app greeted a creator
 * with the OnlyX ring hard against the card's LEFT edge and zero gap to the title. Every content
 * probe passed: the strings were all there, just in the wrong place. So this test asserts rects,
 * not strings: for every className the renderer can set (idle's mark, the spinner, ok, bad, and
 * the help panel's bare `.icon`) the icon's horizontal centre must BE the card's, with its
 * breathing room intact. It also pins the two container behaviours the same screens depend on:
 * the waiting screen fits the smallest window without scrolling, and a help panel taller than
 * the window scrolls to its Back button instead of flex-centring it out past the clipped edges.
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

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onlyx-layout-')), 'report.json');
const probe = path.join(appDir, 'test', 'e2e', 'layout-probe.cjs');
const electron = require('electron');

execFileSync(electron, ['--no-sandbox', '--disable-gpu', probe], {
  cwd: appDir,
  env: { ...process.env, ONLYX_LAYOUT_REPORT: out },
  stdio: 'pipe',
  timeout: 120_000,
});

const report = JSON.parse(fs.readFileSync(out, 'utf8'));
const centreX = (r) => r.left + r.width / 2;
// Sub-pixel rounding is real; a 228px flush-left miss is what this must catch.
const TOLERANCE = 1;

test('every icon the renderer can paint sits on the card centreline, 64px wide, 22px above the title', () => {
  for (const [size, screens] of Object.entries(report)) {
    for (const [name, s] of Object.entries(screens)) {
      if (s.iconHidden) {
        // The help panel hides the slot on purpose. Hidden must mean COLLAPSED: .icon's
        // display:grid outranks the UA's [hidden] rule, so without the page's own CSS this
        // silently reverts to an 86px dead band that pushes help past the default window.
        assert.equal(s.iconOffsetWidth, 0, `${size}/${name}: a hidden icon slot still takes space`);
        continue;
      }
      const icon = centreX(s.icon);
      const card = centreX(s.card);
      assert.ok(
        Math.abs(icon - card) <= TOLERANCE,
        `${size}/${name} (class "${s.iconClass}"): icon centre ${icon} is off the card centre ${card}`,
      );
      // Layout width, not rect width — the spinner is mid-rotation and its client rect lies.
      assert.equal(s.iconOffsetWidth, 64, `${size}/${name}: the icon slot is not 64px`);
      const gap = s.titleOffsetTop - s.iconLayoutBottom;
      assert.ok(gap >= 20 && gap <= 24, `${size}/${name}: icon-to-title gap is ${gap}px, not ~22`);
    }
  }
});

test('the waiting screen fits the smallest window with no scrollbar', () => {
  const s = report.at720x500.idle;
  assert.ok(
    s.fullScrollHeight <= s.fullClientHeight,
    `idle overflows the minimum window: ${s.fullScrollHeight} > ${s.fullClientHeight} — the copy grew past the screen`,
  );
});

test('a help panel taller than the window scrolls to its Back button instead of clipping it', () => {
  const s = report.at720x500.help;
  // Guard the premise: if help ever fits 500px outright, this test stops testing scrolling — fail
  // loudly so the probe height gets lowered rather than the assertion passing by vacancy.
  assert.ok(s.card.height > s.innerHeight, `help now fits ${s.innerHeight}px — shrink the probe viewport to keep this test honest`);
  assert.ok(
    s.backBottomScrolled !== null && s.backBottomScrolled <= s.innerHeight + TOLERANCE,
    `scrolled to the end, Back still sits at ${s.backBottomScrolled} in a ${s.innerHeight}px viewport — the panel clips instead of scrolling`,
  );
});

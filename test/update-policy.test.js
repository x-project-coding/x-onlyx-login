import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isCertSigned, mayPaintUpdate, updateCheckVerdict, updateInstallVerdict } from '../src/update-policy.js';

// Real codesign -dvv shapes, abridged: a Developer ID chain, the ad-hoc signature electron-builder
// applies when no identity is configured, and the message an unsigned binary fails with.
const CODESIGN_DEV_ID = [
  'Executable=/Applications/OnlyX Login.app/Contents/MacOS/OnlyX Login',
  'Identifier=ai.onlyx.login',
  'Format=app bundle with Mach-O universal (x86_64 arm64)',
  'CodeDirectory v=20500 size=1345 flags=0x10000(runtime) hashes=31+7 location=embedded',
  'Signature size=8996',
  'Authority=Developer ID Application: OnlyX LLC (ABCDE12345)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'TeamIdentifier=ABCDE12345',
].join('\n');

const CODESIGN_ADHOC = [
  'Executable=/Applications/OnlyX Login.app/Contents/MacOS/OnlyX Login',
  'Identifier=ai.onlyx.login',
  'CodeDirectory v=20400 size=594 flags=0x2(adhoc) hashes=13+7 location=embedded',
  'Signature=adhoc',
  'TeamIdentifier=not set',
].join('\n');

const CODESIGN_UNSIGNED = '/Applications/OnlyX Login.app/Contents/MacOS/OnlyX Login: code object is not signed at all';

// ---------------------------------------------------------------------------------------------
// updateCheckVerdict
// ---------------------------------------------------------------------------------------------

test('a packaged, signed macOS build and a packaged Windows build both check', () => {
  assert.deepEqual(updateCheckVerdict({ packaged: true, platform: 'darwin', signed: true }), { check: true, reason: 'ok' });
  // signed:false on purpose — Windows NSIS updates unsigned builds, so the signature gate is macOS-only.
  assert.deepEqual(updateCheckVerdict({ packaged: true, platform: 'win32', signed: false }), { check: true, reason: 'ok' });
});

test('an unpackaged app never checks', () => {
  assert.deepEqual(updateCheckVerdict({ packaged: false, platform: 'win32', signed: true }), { check: false, reason: 'unpackaged' });
});

test('a platform with no published artifact never checks', () => {
  assert.deepEqual(updateCheckVerdict({ packaged: true, platform: 'linux', signed: true }), { check: false, reason: 'no_feed_for_platform' });
});

test('an unsigned macOS build never checks — Squirrel.Mac could not install what it promised', () => {
  assert.deepEqual(updateCheckVerdict({ packaged: true, platform: 'darwin', signed: false }), { check: false, reason: 'mac_unsigned' });
});

// ---------------------------------------------------------------------------------------------
// isCertSigned
// ---------------------------------------------------------------------------------------------

test('a Developer ID chain reads as signed', () => {
  assert.equal(isCertSigned(CODESIGN_DEV_ID), true);
});

test('ad-hoc, unsigned, and empty outputs read as not signed', () => {
  assert.equal(isCertSigned(CODESIGN_ADHOC), false);
  assert.equal(isCertSigned(CODESIGN_UNSIGNED), false);
  assert.equal(isCertSigned(''), false);
  assert.equal(isCertSigned(null), false);
  assert.equal(isCertSigned(undefined), false);
});

test('"Authority=" inside an echoed path is not a certificate', () => {
  // codesign prints the executable path verbatim; a path crafted to contain the marker must not
  // arm updates on an ad-hoc build.
  const echoed = [
    'Executable=/tmp/apps/Authority=Developer ID Application/OnlyX Login',
    'Signature=adhoc',
    'TeamIdentifier=not set',
  ].join('\n');
  assert.equal(isCertSigned(echoed), false);
});

// ---------------------------------------------------------------------------------------------
// mayPaintUpdate
// ---------------------------------------------------------------------------------------------

test('the idle screen and the update screens may be painted over', () => {
  assert.equal(mayPaintUpdate('idle'), true);
  assert.equal(mayPaintUpdate('update-downloading'), true);
  assert.equal(mayPaintUpdate('update-ready'), true);
});

test('a run\'s screens are never painted over by the updater', () => {
  for (const phase of ['opening', 'signin', 'captured', 'verifying', 'success', 'error']) {
    assert.equal(mayPaintUpdate(phase), false, `painting over '${phase}' would replace what the creator is using or reading`);
  }
});

// ---------------------------------------------------------------------------------------------
// updateInstallVerdict
// ---------------------------------------------------------------------------------------------

test('a downloaded update installs when nothing is in progress', () => {
  assert.deepEqual(updateInstallVerdict({ runActive: false, downloaded: true }), { install: true, reason: 'ok' });
});

test('a run in progress blocks the install — a restart would destroy her sign-in', () => {
  assert.deepEqual(updateInstallVerdict({ runActive: true, downloaded: true }), { install: false, reason: 'run_in_progress' });
});

test('nothing downloaded means nothing to install', () => {
  assert.deepEqual(updateInstallVerdict({ runActive: false, downloaded: false }), { install: false, reason: 'not_downloaded' });
});

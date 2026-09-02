import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SCHEME, claimFromArgv, parseDeepLink } from '../src/deep-link.js';

const CLAIM = 'abcDEF012_-abcDEF012';

test('parses the canonical link', () => {
  assert.deepEqual(parseDeepLink(`onlyx-connect://open?c=${CLAIM}`), { claim: CLAIM });
});

test('parses the schemeless-authority form', () => {
  assert.deepEqual(parseDeepLink(`onlyx-connect:open?c=${CLAIM}`), { claim: CLAIM });
});

test('tolerates a trailing slash on the action and surrounding quotes', () => {
  assert.deepEqual(parseDeepLink(`"onlyx-connect://open/?c=${CLAIM}"`), { claim: CLAIM });
  assert.deepEqual(parseDeepLink(`  onlyx-connect://open?c=${CLAIM}  `), { claim: CLAIM });
});

test('is case-insensitive on scheme and action but keeps the claim verbatim', () => {
  assert.deepEqual(parseDeepLink(`ONLYX-CONNECT://OPEN?c=${CLAIM}`), { claim: CLAIM });
});

test('rejects a foreign scheme, wrong action, or missing claim', () => {
  assert.equal(parseDeepLink(`https://onlyx.ai/open?c=${CLAIM}`), null);
  assert.equal(parseDeepLink(`onlyx-connect://logout?c=${CLAIM}`), null);
  assert.equal(parseDeepLink('onlyx-connect://open'), null);
  assert.equal(parseDeepLink('onlyx-connect://open?c='), null);
});

test('rejects a claim that is too short, too long, or has stray characters', () => {
  assert.equal(parseDeepLink('onlyx-connect://open?c=short'), null);
  assert.equal(parseDeepLink(`onlyx-connect://open?c=${'a'.repeat(513)}`), null);
  assert.equal(parseDeepLink('onlyx-connect://open?c=has spaces here'), null);
  assert.equal(parseDeepLink('onlyx-connect://open?c=has/slash/inside'), null);
});

test('rejects non-strings and junk', () => {
  for (const junk of [null, undefined, 42, {}, '', 'not a url at all']) assert.equal(parseDeepLink(junk), null);
});

test('claimFromArgv finds the link anywhere in argv, or returns null', () => {
  assert.equal(claimFromArgv(['/path/electron', '--flag', `onlyx-connect://open?c=${CLAIM}`]), CLAIM);
  assert.equal(claimFromArgv(['/path/electron', '.']), null);
  assert.equal(claimFromArgv([]), null);
  assert.equal(claimFromArgv(undefined), null);
});

test('the scheme constant is what the app registers', () => {
  assert.equal(SCHEME, 'onlyx-connect');
});

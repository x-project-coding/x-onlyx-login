import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ME_PATH,
  buildSessionPayload,
  hasLoginCookies,
  isMeUrl,
  judgeMe,
} from '../src/session-capture.js';

const of = (name, value, extra = {}) => ({ name, value, domain: '.onlyfans.com', path: '/', ...extra });

test('isMeUrl accepts onlyfans hosts on the me path only', () => {
  assert.equal(isMeUrl(`https://onlyfans.com${ME_PATH}`), true);
  assert.equal(isMeUrl(`https://www.onlyfans.com${ME_PATH}?x=1`), true);
  assert.equal(isMeUrl('https://onlyfans.com/api2/v2/users/list'), false);
  assert.equal(isMeUrl(`https://evil-onlyfans.com${ME_PATH}`), false);
  assert.equal(isMeUrl(`https://onlyfans.com.evil.test${ME_PATH}`), false);
  assert.equal(isMeUrl('not a url'), false);
});

test('judgeMe names a real user and rejects the guest answer', () => {
  assert.deepEqual(judgeMe({ id: 12345, username: 'creator' }), { id: '12345', username: 'creator' });
  assert.deepEqual(judgeMe('{"id":"7","username":null}'), { id: '7', username: null });
  assert.equal(judgeMe({}), null); // guest: 200 with no id
  assert.equal(judgeMe('{"error":{}}'), null);
  assert.equal(judgeMe('<html>not json</html>'), null);
  assert.equal(judgeMe(null), null);
});

test('hasLoginCookies needs both sess and auth_id with values on an onlyfans domain', () => {
  assert.equal(hasLoginCookies([of('sess', 'abc'), of('auth_id', '99')]), true);
  assert.equal(hasLoginCookies([of('sess', 'abc')]), false);
  assert.equal(hasLoginCookies([of('sess', ''), of('auth_id', '99')]), false);
  assert.equal(
    hasLoginCookies([
      { name: 'sess', value: 'abc', domain: 'example.com' },
      { name: 'auth_id', value: '99', domain: 'example.com' },
    ]),
    false,
  );
  assert.equal(hasLoginCookies([]), false);
  assert.equal(hasLoginCookies(undefined), false);
});

test('buildSessionPayload keeps login cookies, drops Cloudflare and empty ones', () => {
  const payload = buildSessionPayload(
    [
      of('sess', 'S'),
      of('auth_id', '99'),
      of('__cf_bm', 'x'),
      of('_cfuvid', 'y'),
      of('empty', ''),
      { name: 'foreign', value: 'z', domain: 'example.com' },
    ],
    null,
    { now: () => new Date('2026-09-02T00:00:00.000Z') },
  );
  const names = payload.cookies.map((c) => c.name).sort();
  assert.deepEqual(names, ['auth_id', 'sess']);
  assert.equal(payload.cookieHeader, 'sess=S; auth_id=99');
  assert.equal(payload.capturedAt, '2026-09-02T00:00:00.000Z');
  assert.equal(payload.xbc, null);
  assert.equal(payload.xbcKey, null);
});

test('buildSessionPayload marks a session cookie -1 and passes an expiry through', () => {
  const payload = buildSessionPayload(
    [
      of('sess', 'S', { session: true }),
      of('auth_id', '99', { expirationDate: 1893456000, httpOnly: true, secure: true }),
    ],
    { key: 'xbc', value: 'a'.repeat(40) },
  );
  const bySess = Object.fromEntries(payload.cookies.map((c) => [c.name, c]));
  assert.equal(bySess.sess.expires, -1);
  assert.equal(bySess.auth_id.expires, 1893456000);
  assert.equal(bySess.auth_id.httpOnly, true);
  assert.equal(bySess.auth_id.secure, true);
  assert.equal(payload.xbc, 'a'.repeat(40));
  assert.equal(payload.xbcKey, 'xbc');
});

test('buildSessionPayload defaults a missing path to /', () => {
  const [cookie] = buildSessionPayload([{ name: 'sess', value: 'S', domain: '.onlyfans.com' }], null).cookies;
  assert.equal(cookie.path, '/');
});

test('the cookie domain check is anchored, like the URL check', () => {
  // `.includes("onlyfans.com")` also matches these two. A jar filter and a URL filter that
  // disagree about what OnlyFans is will eventually be handed a cookie from the wrong place.
  const lookalikes = [
    { name: 'sess', value: 'S', domain: 'x-onlyfans.com' },
    { name: 'auth_id', value: '9', domain: 'x-onlyfans.com' },
    { name: 'sess', value: 'S', domain: 'onlyfans.com.evil.test' },
    { name: 'auth_id', value: '9', domain: 'onlyfans.com.evil.test' },
  ];
  assert.equal(hasLoginCookies(lookalikes), false);
  assert.deepEqual(buildSessionPayload(lookalikes, null).cookies, []);

  // The real shapes still pass: the bare host, and the leading-dot form OnlyFans actually sets.
  assert.equal(hasLoginCookies([
    { name: 'sess', value: 'S', domain: 'onlyfans.com' },
    { name: 'auth_id', value: '9', domain: '.onlyfans.com' },
  ]), true);
  assert.equal(
    buildSessionPayload([{ name: 'sess', value: 'S', domain: 'www.onlyfans.com' }], null).cookies.length,
    1,
  );
});

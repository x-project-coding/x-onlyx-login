import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError, OnlyxApi } from '../src/api.js';

/** A fetch stub that records the last call and returns a scripted response. */
const stubFetch = (impl) => {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return impl(url, opts);
  };
  fn.calls = calls;
  return fn;
};

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

test('open posts the claim, the app metadata and this build\'s capabilities', async () => {
  const fetch = stubFetch(() => jsonResponse(200, { sessionToken: 'T', account: { username: 'c' } }));
  const api = new OnlyxApi('https://of-api.onlyx.ai/', { fetch, appVersion: '1.0.0', platform: 'darwin-arm64' });
  const out = await api.open('claim123456');
  assert.equal(out.sessionToken, 'T');
  const { url, opts } = fetch.calls[0];
  assert.equal(url, 'https://of-api.onlyx.ai/connect-app/open'); // trailing slash trimmed
  assert.equal(opts.method, 'POST');
  // `caps` is what lets the server tell this build from v1.1.0 and offer it the honest identity;
  // without it every install would keep the seat's, whatever the server was configured to do.
  assert.deepEqual(JSON.parse(opts.body), {
    claim: 'claim123456',
    appVersion: '1.0.0',
    platform: 'darwin-arm64',
    caps: ['nativeIdentity'],
  });
  assert.equal(opts.headers['content-type'], 'application/json');
});

test('importSession and status send the bearer token', async () => {
  const fetch = stubFetch(() => jsonResponse(200, { ok: true }));
  const api = new OnlyxApi('https://of-api.onlyx.ai', { fetch });
  await api.importSession('TOKEN', { session: {} });
  await api.status('TOKEN');
  assert.equal(fetch.calls[0].opts.headers.authorization, 'Bearer TOKEN');
  assert.equal(fetch.calls[0].url, 'https://of-api.onlyx.ai/connect-app/session');
  assert.equal(fetch.calls[1].opts.method, 'GET');
  assert.equal(fetch.calls[1].url, 'https://of-api.onlyx.ai/connect-app/status');
});

test('a non-ok response becomes an ApiError carrying the server code', async () => {
  const fetch = stubFetch(() => jsonResponse(404, { error: 'invalid_or_spent' }));
  const api = new OnlyxApi('https://of-api.onlyx.ai', { fetch });
  await assert.rejects(api.open('claim123456'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 404);
    assert.equal(err.code, 'invalid_or_spent');
    return true;
  });
});

test('a non-ok response with no json body falls back to http_<status>', async () => {
  const fetch = stubFetch(() => jsonResponse(503, undefined));
  const api = new OnlyxApi('https://of-api.onlyx.ai', { fetch });
  await assert.rejects(api.status('T'), (err) => err.code === 'http_503' && err.status === 503);
});

test('a network failure is code "unreachable"', async () => {
  const fetch = stubFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  const api = new OnlyxApi('https://of-api.onlyx.ai', { fetch });
  await assert.rejects(api.open('claim123456'), (err) => err.code === 'unreachable' && err.status === 0);
});

test('an aborted request is code "timeout"', async () => {
  const fetch = stubFetch(() => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  });
  const api = new OnlyxApi('https://of-api.onlyx.ai', { fetch });
  await assert.rejects(api.open('claim123456'), (err) => err.code === 'timeout');
});

test('base is normalized and readable', () => {
  assert.equal(new OnlyxApi('https://x.test///', { fetch: stubFetch(() => {}) }).base, 'https://x.test');
});

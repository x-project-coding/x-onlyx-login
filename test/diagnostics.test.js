/**
 * The sign-in record: what it writes down, what it refuses to write down, and the fact that it is
 * off unless somebody asks.
 *
 * Two of these are load-bearing beyond "the function works":
 *   - `diagnosticTarget` returning null on a bare environment is the whole "off by default"
 *     promise. If it ever returned a path for an unset variable, every creator's machine would
 *     start keeping a file about her sign-in.
 *   - `redactUrl` dropping query VALUES is what makes the file safe to hand over. A verification
 *     handoff carries its session in the query string and the fragment; both are the secret.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  attachContentsDiagnostics,
  diagnosticTarget,
  openRecorder,
  popupsAllowed,
  redactText,
  redactUrl,
} from '../src/diagnostics.js';

const AT = () => new Date('2026-09-02T10:20:30.400Z');

// ---------------------------------------------------------------------------------------------
// Off unless asked
// ---------------------------------------------------------------------------------------------

test('no environment variable means no record at all', () => {
  assert.equal(diagnosticTarget({ env: {}, logDir: '/logs' }), null);
  assert.equal(diagnosticTarget({ logDir: '/logs' }), null);
  assert.equal(diagnosticTarget(), null);
});

test('an empty or negative value is off, in any spelling', () => {
  for (const value of ['', '   ', '0', 'false', 'off', 'no', 'OFF', 'False']) {
    assert.equal(diagnosticTarget({ env: { ONLYX_LOGIN_DIAG: value }, logDir: '/logs' }), null, `"${value}" must be off`);
  }
});

test('a bare truthy value names a file in the app log directory, stamped with the time', () => {
  const file = diagnosticTarget({ env: { ONLYX_LOGIN_DIAG: '1' }, logDir: '/logs', now: AT, packaged: true });
  assert.equal(file, '/logs/onlyx-login-signin-2026-09-02T10-20-30-400.log');
});

test('an unpackaged run marks its file, so a developer log is never mistaken for a creator one', () => {
  const file = diagnosticTarget({ env: { ONLYX_LOGIN_DIAG: 'yes' }, logDir: '/logs', now: AT, packaged: false });
  assert.match(file, /-dev\.log$/);
});

test('a value that looks like a path is the exact file — how the end-to-end test pins it', () => {
  assert.equal(diagnosticTarget({ env: { ONLYX_LOGIN_DIAG: '/tmp/x/run.log' }, logDir: '/logs' }), '/tmp/x/run.log');
  assert.equal(diagnosticTarget({ env: { ONLYX_LOGIN_DIAG: 'C:\\t\\run.log' }, logDir: '/logs' }), 'C:\\t\\run.log');
});

test('popups are refused unless the run explicitly allows them', () => {
  assert.equal(popupsAllowed({ env: {} }), false);
  assert.equal(popupsAllowed(), false);
  for (const value of ['deny', 'off', '0', 'false', 'no']) {
    assert.equal(popupsAllowed({ env: { ONLYX_LOGIN_POPUPS: value } }), false, `"${value}" must not allow popups`);
  }
  for (const value of ['allow', 'on', '1', 'true', ' ALLOW ']) {
    assert.equal(popupsAllowed({ env: { ONLYX_LOGIN_POPUPS: value } }), true, `"${value}" must allow popups`);
  }
});

// ---------------------------------------------------------------------------------------------
// What must never reach the file
// ---------------------------------------------------------------------------------------------

test('a URL keeps its origin and path and loses every query VALUE', () => {
  const out = redactUrl('https://id.onlyfans.com/verify/start?session=abc123SECRETvalue&lang=en');
  assert.equal(out, 'https://id.onlyfans.com/verify/start ?session,lang');
  assert.ok(!out.includes('abc123SECRETvalue'), 'the query value must not survive');
  assert.ok(!out.includes('=en'), 'no query value at all, not even a harmless one');
});

test('a fragment is reduced to its length — a handoff token often lives there', () => {
  const out = redactUrl('https://id.onlyfans.com/v#tok_0123456789abcdef');
  assert.equal(out, 'https://id.onlyfans.com/v #<20 chars>');
  assert.ok(!out.includes('tok_'), 'the fragment body must not survive');
});

test('an opaque URL is recorded as its scheme and a size, never its body', () => {
  assert.equal(redactUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='), 'data:<58 chars>');
  assert.equal(redactUrl('javascript:void(document.cookie)'), 'javascript:<32 chars>');
  assert.match(redactUrl('blob:https://onlyfans.com/9f0e-1'), /^blob:<\d+ chars>$/);
});

test('the schemes the guard blocks are still legible, because that is the diagnostic', () => {
  assert.equal(redactUrl('about:blank'), 'about:blank');
  assert.equal(redactUrl('onlyfans-verify://continue'), 'onlyfans-verify://continue');
  assert.equal(redactUrl('http://insecure.example/x?a=1'), 'http://insecure.example/x ?a');
});

test('a missing or unparseable URL never throws', () => {
  assert.equal(redactUrl(null), '<none>');
  assert.equal(redactUrl(''), '<none>');
  assert.equal(redactUrl(undefined), '<none>');
  assert.equal(redactUrl('/relative/path?token=secret0123456789'), '/relative/path');
});

test('a long URL is capped', () => {
  const out = redactUrl(`https://onlyfans.com/${'a'.repeat(600)}`);
  assert.ok(out.length <= 301, `capped, got ${out.length}`);
});

test('console text has token-shaped runs masked', () => {
  const out = redactText('failed for bc 0123456789abcdef0123456789abcdef01234567 at step 2');
  assert.ok(!out.includes('0123456789abcdef'), 'the device token must not survive');
  assert.match(out, /<redacted:40>/);
  assert.match(out, /^failed for bc /);
});

test('a long identifier with no digits survives — the errors worth reading are full of them', () => {
  const text = 'TypeError: window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable is not a function';
  assert.equal(redactText(text), text);
});

test('console text is truncated, and says how much it dropped', () => {
  const out = redactText('x'.repeat(500), { max: 100 });
  assert.equal(out, `${'x'.repeat(100)}…(+400)`);
  assert.equal(redactText(null), '');
});

// ---------------------------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------------------------

const collectingRecorder = (overrides = {}) => {
  const lines = [];
  const recorder = openRecorder({
    file: '/dev/null',
    meta: { app: '1.1.0' },
    now: AT,
    append: (_file, line) => lines.push(JSON.parse(line)),
    ...overrides,
  });
  return { recorder, lines };
};

test('no file means no recorder — the callers all null-check one object', () => {
  assert.equal(openRecorder({ file: null }), null);
  assert.equal(openRecorder({}), null);
});

test('a recorder opens with a header naming the build, then one line per event', () => {
  const { recorder, lines } = collectingRecorder();
  recorder.record('window-open', { url: 'https://id.onlyfans.com/x', decision: 'deny' });
  assert.deepEqual(lines[0], { t: '2026-09-02T10:20:30.400Z', kind: 'diagnostic-start', app: '1.1.0' });
  assert.deepEqual(lines[1], {
    t: '2026-09-02T10:20:30.400Z',
    kind: 'window-open',
    url: 'https://id.onlyfans.com/x',
    decision: 'deny',
  });
});

test('a disk that refuses the write disables the recorder instead of failing the sign-in', () => {
  let calls = 0;
  const recorder = openRecorder({
    file: '/nope/nope.log',
    now: AT,
    append: () => {
      calls += 1;
      throw new Error('EACCES');
    },
  });
  assert.equal(recorder.disabled, true, 'one failure is enough');
  assert.doesNotThrow(() => recorder.record('state', { phase: 'signin' }));
  assert.equal(calls, 1, 'it does not retry on every navigation');
});

// ---------------------------------------------------------------------------------------------
// The passive listeners
// ---------------------------------------------------------------------------------------------

test('navigations are recorded from either event shape, and detach really unhooks', () => {
  const { recorder, lines } = collectingRecorder();
  const contents = new EventEmitter();
  const detach = attachContentsDiagnostics(contents, recorder, { tag: 'signin' });

  // Electron 44's details object...
  contents.emit('will-navigate', { url: 'https://id.onlyfans.com/go?s=secret999' });
  // ...and the deprecated positional argument it still passes after it.
  contents.emit('will-redirect', {}, 'https://onlyfans.com/after');

  const kinds = lines.map((l) => l.kind);
  assert.deepEqual(kinds, ['diagnostic-start', 'will-navigate', 'will-redirect']);
  assert.equal(lines[1].url, 'https://id.onlyfans.com/go ?s');
  assert.equal(lines[1].view, 'signin');
  assert.equal(lines[2].url, 'https://onlyfans.com/after');

  detach();
  contents.emit('will-navigate', { url: 'https://onlyfans.com/later' });
  assert.equal(lines.length, 3, 'nothing is recorded after detach');
});

test('a failed load keeps its error code — that is how a blocked handoff is told from a 404', () => {
  const { recorder, lines } = collectingRecorder();
  const contents = new EventEmitter();
  attachContentsDiagnostics(contents, recorder, { tag: 'signin' });
  contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://id.onlyfans.com/x?t=1', true);
  assert.deepEqual(lines[1], {
    t: '2026-09-02T10:20:30.400Z',
    kind: 'did-fail-load',
    view: 'signin',
    errorCode: -3,
    error: 'ERR_ABORTED',
    url: 'https://id.onlyfans.com/x ?t',
    mainFrame: true,
  });
});

test('only errors and warnings are kept: a live site logs thousands of info lines', () => {
  const { recorder, lines } = collectingRecorder();
  const contents = new EventEmitter();
  attachContentsDiagnostics(contents, recorder, { tag: 'signin' });
  contents.emit('console-message', { level: 'info', message: 'hello', sourceId: 'https://onlyfans.com/a.js', lineNumber: 1 });
  contents.emit('console-message', { level: 'debug', message: 'hello', sourceId: 'https://onlyfans.com/a.js', lineNumber: 1 });
  contents.emit('console-message', { level: 'error', message: 'boom 0123456789abcdef0123456789abcdef01234567', sourceId: 'https://id.onlyfans.com/v.js?v=9', lineNumber: 42 });
  contents.emit('console-message', { level: 'warning', message: 'careful', sourceId: 'https://onlyfans.com/b.js', lineNumber: 7 });

  const kinds = lines.map((l) => l.kind);
  assert.deepEqual(kinds, ['diagnostic-start', 'console', 'console']);
  assert.equal(lines[1].level, 'error');
  assert.equal(lines[1].line, 42);
  assert.equal(lines[1].source, 'https://id.onlyfans.com/v.js ?v');
  assert.match(lines[1].text, /^boom <redacted:40>$/);
  assert.equal(lines[2].level, 'warning');
});

test('a listener that throws never reaches the view it is watching', () => {
  const contents = new EventEmitter();
  const recorder = {
    record() {
      throw new Error('disk is on fire');
    },
  };
  attachContentsDiagnostics(contents, recorder, { tag: 'signin' });
  assert.doesNotThrow(() => contents.emit('will-navigate', { url: 'https://onlyfans.com/' }));
});

test('no recorder means no listeners are attached at all', () => {
  const contents = new EventEmitter();
  const detach = attachContentsDiagnostics(contents, null, { tag: 'signin' });
  assert.equal(contents.eventNames().length, 0);
  assert.doesNotThrow(detach);
});

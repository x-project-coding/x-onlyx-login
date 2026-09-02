import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TUNNEL_CLOSE,
  messageForFailedConnect,
  messageForImport,
  messageForOpen,
  messageForTunnel,
} from '../src/messages.js';

const wellFormed = (m) => typeof m?.title === 'string' && m.title.length > 0 && typeof m?.detail === 'string' && m.detail.length > 0;

test('every open/import/tunnel code maps to a well-formed message', () => {
  for (const code of ['invalid_or_spent', 'claim_required', 'account_unavailable', 'no_egress', 'worker_not_ready', 'unreachable', 'timeout']) {
    assert.ok(wellFormed(messageForOpen(code)), code);
  }
  for (const code of ['pass_invalid', 'session_unusable', 'wrong_creator', 'duplicate_account', 'proxy_changed', 'already_imported', 'unreachable']) {
    assert.ok(wellFormed(messageForImport(code)), code);
  }
  for (const reason of Object.values(TUNNEL_CLOSE).concat(['unauthorized'])) {
    assert.ok(wellFormed(messageForTunnel(reason)), reason);
  }
});

test('an unknown code still yields a generic, well-formed message', () => {
  assert.ok(wellFormed(messageForOpen('who_knows')));
  assert.ok(wellFormed(messageForImport(undefined)));
  assert.ok(wellFormed(messageForTunnel('nonsense')));
});

test('failed-connect embeds the reason when there is one', () => {
  assert.match(messageForFailedConnect('signature_mismatch').detail, /signature_mismatch/);
  assert.ok(wellFormed(messageForFailedConnect(null)));
});

test('no message leaks internal infrastructure words', () => {
  const collect = [
    ...['invalid_or_spent', 'no_egress', 'worker_not_ready'].map(messageForOpen),
    ...['wrong_creator', 'duplicate_account'].map(messageForImport),
    ...Object.values(TUNNEL_CLOSE).map(messageForTunnel),
  ];
  const forbidden = /\b(proxy|seat|worker|postgres|redis|docker|container|prisma)\b/i;
  for (const m of collect) {
    assert.ok(!forbidden.test(m.title), `title leaks: ${m.title}`);
    assert.ok(!forbidden.test(m.detail), `detail leaks: ${m.detail}`);
  }
});

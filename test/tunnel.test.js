import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';

import {
  basicCredential,
  parseAuthority,
  parseRequestHead,
  reasonForClose,
  startForwarder,
} from '../src/tunnel.js';

// --- pure helpers ---------------------------------------------------------------------------

test('parseRequestHead reads the request line and headers, or null', () => {
  const head = parseRequestHead('CONNECT onlyfans.com:443 HTTP/1.1\r\nProxy-Authorization: Basic x\r\nHost: y\r\n');
  assert.deepEqual(head, { method: 'CONNECT', target: 'onlyfans.com:443', headers: { 'proxy-authorization': 'Basic x', host: 'y' } });
  assert.equal(parseRequestHead('garbage'), null);
});

test('parseAuthority accepts host:443, rejects bad ports and IPv6 literals', () => {
  assert.deepEqual(parseAuthority('onlyfans.com:443'), { host: 'onlyfans.com', port: 443 });
  assert.deepEqual(parseAuthority('WWW.OnlyFans.com:443'), { host: 'www.onlyfans.com', port: 443 });
  assert.equal(parseAuthority('onlyfans.com:0'), null);
  assert.equal(parseAuthority('onlyfans.com:99999'), null);
  assert.equal(parseAuthority('[::1]:443'), null);
  assert.equal(parseAuthority('onlyfans.com'), null);
});

test('reasonForClose maps 4xxx codes and http refusals', () => {
  assert.equal(reasonForClose(4403), 'target_refused');
  assert.equal(reasonForClose(4407), 'proxy_auth');
  assert.equal(reasonForClose(4413), 'byte_budget');
  assert.equal(reasonForClose(401), 'unauthorized');
  assert.equal(reasonForClose(403), 'target_refused');
  assert.equal(reasonForClose(429, 'Too Many Streams'), 'too_many_streams');
  assert.equal(reasonForClose(429, 'Byte Budget Spent'), 'byte_budget');
  assert.equal(reasonForClose(1000), null);
});

// --- a configurable fake tunnel -------------------------------------------------------------

/**
 * A stand-in for the API tunnel. `behavior(ctx)` decides what happens on each upgrade:
 *   { refuse:{code,text} }                 refuse the WS upgrade with that HTTP status
 *   { onOpen(ws, ctx) }                    accept it and take over the socket
 */
const makeTunnel = async (behavior) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const seen = [];
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const ctx = { host: url.searchParams.get('host'), port: url.searchParams.get('port'), auth: req.headers.authorization };
    seen.push(ctx);
    const decision = behavior(ctx) ?? {};
    if (decision.refuse) {
      socket.write(`HTTP/1.1 ${decision.refuse.code} ${decision.refuse.text}\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => decision.onOpen?.(ws, ctx));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `ws://127.0.0.1:${port}/connect-app/tunnel`, seen, close: () => new Promise((r) => server.close(r)) };
};

/** A tunnel that connects and echoes every binary frame back — a stand-in for the far site. */
const echoTunnel = () => makeTunnel(() => ({
  onOpen: (ws) => {
    ws.send(JSON.stringify({ t: 'ready' }));
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
  },
}));

/** Send one CONNECT (or arbitrary head) and resolve with the parsed status line + the live socket. */
const sendConnect = (port, { line, cred, target = 'onlyfans.com:443' } = {}) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      if (line) socket.write(line);
      else socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${cred ? `Proxy-Authorization: ${cred}\r\n` : ''}\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      const first = buf.subarray(0, end).toString('latin1').split('\r\n')[0];
      const m = /^HTTP\/1\.[01] (\d+) ?(.*)$/.exec(first);
      resolve({ status: m ? Number(m[1]) : 0, statusText: m ? m[2] : first, socket, leftover: buf.subarray(end + 4) });
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });

const credFor = (fwd) => basicCredential(fwd.auth.username, fwd.auth.password);

// --- the forwarder end to end ---------------------------------------------------------------

test('a CONNECT with the right credential opens and round-trips bytes', async () => {
  const tunnel = await echoTunnel();
  const fwd = await startForwarder({ tunnelUrl: tunnel.url, sessionToken: 'TOK' });
  try {
    const { status, socket } = await sendConnect(fwd.port, { cred: credFor(fwd) });
    assert.equal(status, 200);
    socket.write(Buffer.from('hello onlyfans'));
    const [echo] = await once(socket, 'data');
    assert.equal(echo.toString(), 'hello onlyfans');
    socket.destroy();
    // the tunnel saw our target and our bearer
    assert.equal(tunnel.seen[0].host, 'onlyfans.com');
    assert.equal(tunnel.seen[0].port, '443');
    assert.equal(tunnel.seen[0].auth, 'Bearer TOK');
    assert.equal(fwd.stats.ready, 1);
    assert.ok(fwd.stats.bytesUp >= 14 && fwd.stats.bytesDown >= 14);
  } finally {
    await fwd.close();
    await tunnel.close();
  }
});

test('a larger payload round-trips intact through the pipes', async () => {
  const tunnel = await echoTunnel();
  const fwd = await startForwarder({ tunnelUrl: tunnel.url, sessionToken: 'TOK' });
  try {
    const { status, socket } = await sendConnect(fwd.port, { cred: credFor(fwd) });
    assert.equal(status, 200);
    const payload = Buffer.alloc(512 * 1024, 7);
    const chunks = [];
    let got = 0;
    const done = new Promise((resolve) => {
      socket.on('data', (c) => {
        chunks.push(c);
        got += c.length;
        if (got >= payload.length) resolve();
      });
    });
    socket.write(payload);
    await done;
    assert.ok(Buffer.concat(chunks).subarray(0, payload.length).equals(payload));
    socket.destroy();
  } finally {
    await fwd.close();
    await tunnel.close();
  }
});

test('a non-CONNECT request is refused 405', async () => {
  const tunnel = await echoTunnel();
  const fwd = await startForwarder({ tunnelUrl: tunnel.url, sessionToken: 'TOK' });
  try {
    const { status } = await sendConnect(fwd.port, { line: 'GET http://onlyfans.com/ HTTP/1.1\r\nHost: onlyfans.com\r\n\r\n' });
    assert.equal(status, 405);
    assert.equal(tunnel.seen.length, 0); // never dialed
  } finally {
    await fwd.close();
    await tunnel.close();
  }
});

test('a missing or wrong proxy credential is refused 407', async () => {
  const tunnel = await echoTunnel();
  const fwd = await startForwarder({ tunnelUrl: tunnel.url, sessionToken: 'TOK' });
  try {
    const missing = await sendConnect(fwd.port, {});
    assert.equal(missing.status, 407);
    const wrong = await sendConnect(fwd.port, { cred: basicCredential('onlyx', 'not-the-password') });
    assert.equal(wrong.status, 407);
    assert.equal(tunnel.seen.length, 0);
  } finally {
    await fwd.close();
    await tunnel.close();
  }
});

test('a non-443 port and a bad authority are refused 403', async () => {
  const tunnel = await echoTunnel();
  const fwd = await startForwarder({ tunnelUrl: tunnel.url, sessionToken: 'TOK' });
  try {
    const wrongPort = await sendConnect(fwd.port, { cred: credFor(fwd), target: 'onlyfans.com:8080' });
    assert.equal(wrongPort.status, 403);
    const ipv6 = await sendConnect(fwd.port, { cred: credFor(fwd), target: '[::1]:443' });
    assert.equal(ipv6.status, 403); // a valid request line, but parseAuthority refuses the literal
  } finally {
    await fwd.close();
    await tunnel.close();
  }
});

test('an oversized request head is refused 431', async () => {
  const tunnel = await echoTunnel();
  const fwd = await startForwarder({ tunnelUrl: tunnel.url, sessionToken: 'TOK' });
  try {
    const socket = net.connect(fwd.port, '127.0.0.1', () => {
      socket.write('CONNECT onlyfans.com:443 HTTP/1.1\r\n');
      socket.write(`X-Pad: ${'a'.repeat(20 * 1024)}`); // never completes the head, exceeds the cap
    });
    const [chunk] = await once(socket, 'data');
    assert.match(chunk.toString('latin1'), /^HTTP\/1\.1 431 /);
    socket.destroy();
  } finally {
    await fwd.close();
    await tunnel.close();
  }
});

test('a refused oversized head stops being read, so the peer cannot grow it for ever', async () => {
  // The defect this guards: `reply` half-closes the WRITABLE side only. With the data listener
  // still attached, an unauthenticated local peer could keep streaming into the head buffer until
  // the app ran out of memory. Asserted through `stats.refused`, which the listener increments —
  // if it is still attached, the count climbs with every further chunk.
  const tunnel = await echoTunnel();
  const fwd = await startForwarder({ tunnelUrl: tunnel.url, sessionToken: 'TOK' });
  try {
    const socket = net.connect(fwd.port, '127.0.0.1', () => {
      socket.write('CONNECT onlyfans.com:443 HTTP/1.1\r\n');
      socket.write(`X-Pad: ${'a'.repeat(20 * 1024)}`);
    });
    await once(socket, 'data');
    assert.equal(fwd.stats.refused, 1);

    for (let i = 0; i < 8; i++) socket.write('b'.repeat(8 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(fwd.stats.refused, 1, 'the forwarder kept reading a head it had already refused');
    socket.destroy();
  } finally {
    await fwd.close();
    await tunnel.close();
  }
});

test('the tunnel answering {t:error} yields 502 to the client', async () => {
  const tunnel = await makeTunnel(() => ({ onOpen: (ws) => ws.send(JSON.stringify({ t: 'error', reason: 'proxy_error' })) }));
  const fatal = [];
  const fwd = await startForwarder({ tunnelUrl: tunnel.url, sessionToken: 'TOK', onFatal: (r) => fatal.push(r) });
  try {
    const { status } = await sendConnect(fwd.port, { cred: credFor(fwd) });
    assert.equal(status, 502);
    assert.deepEqual(fatal, []); // proxy_error is not fatal-for-the-run
  } finally {
    await fwd.close();
    await tunnel.close();
  }
});

test('a refused upgrade (401) is fatal and surfaces 502', async () => {
  const tunnel = await makeTunnel(() => ({ refuse: { code: 401, text: 'Unauthorized' } }));
  const fatal = [];
  const fwd = await startForwarder({ tunnelUrl: tunnel.url, sessionToken: 'TOK', onFatal: (r) => fatal.push(r) });
  try {
    const { status } = await sendConnect(fwd.port, { cred: credFor(fwd) });
    assert.equal(status, 502);
    assert.deepEqual(fatal, ['unauthorized']);
  } finally {
    await fwd.close();
    await tunnel.close();
  }
});

test('a 429 "Too Many Streams" refusal is not fatal', async () => {
  const tunnel = await makeTunnel(() => ({ refuse: { code: 429, text: 'Too Many Streams' } }));
  const fatal = [];
  const fwd = await startForwarder({ tunnelUrl: tunnel.url, sessionToken: 'TOK', onFatal: (r) => fatal.push(r) });
  try {
    const { status } = await sendConnect(fwd.port, { cred: credFor(fwd) });
    assert.equal(status, 502);
    assert.deepEqual(fatal, []);
    assert.equal(fwd.stats.lastReason, 'too_many_streams');
  } finally {
    await fwd.close();
    await tunnel.close();
  }
});

test('a post-ready close code names the reason; 4413 is fatal, 4403 is not', async () => {
  for (const [code, reason, isFatal] of [[4413, 'byte_budget', true], [4403, 'target_refused', false]]) {
    const tunnel = await makeTunnel(() => ({
      onOpen: (ws) => {
        ws.send(JSON.stringify({ t: 'ready' }));
        setTimeout(() => ws.close(code), 20);
      },
    }));
    const fatal = [];
    const fwd = await startForwarder({ tunnelUrl: tunnel.url, sessionToken: 'TOK', onFatal: (r) => fatal.push(r) });
    try {
      const { status, socket } = await sendConnect(fwd.port, { cred: credFor(fwd) });
      assert.equal(status, 200); // ready arrived before the close
      await once(socket, 'close');
      assert.equal(fwd.stats.lastReason, reason);
      assert.deepEqual(fatal, isFatal ? [reason] : []);
    } finally {
      await fwd.close();
      await tunnel.close();
    }
  }
});

test('proxyConfig routes every scheme through the loopback port with no bypass', async () => {
  const tunnel = await echoTunnel();
  const fwd = await startForwarder({ tunnelUrl: tunnel.url, sessionToken: 'TOK' });
  try {
    assert.equal(fwd.proxyConfig.proxyRules, `http=127.0.0.1:${fwd.port};https=127.0.0.1:${fwd.port}`);
    assert.equal(fwd.proxyConfig.proxyBypassRules, '<-loopback>');
    assert.equal(fwd.auth.username, 'onlyx');
    assert.ok(fwd.auth.password.length >= 24);
  } finally {
    await fwd.close();
    await tunnel.close();
  }
});

test('startForwarder requires a url and token', async () => {
  await assert.rejects(startForwarder({ sessionToken: 'T' }), /required/);
  await assert.rejects(startForwarder({ tunnelUrl: 'ws://x/' }), /required/);
});

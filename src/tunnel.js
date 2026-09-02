/**
 * The loopback forwarder: an HTTP CONNECT proxy on 127.0.0.1 that turns every stream the sign-in
 * browser opens into one WebSocket to the OnlyX API, which dials onward through the account's own
 * proxy.
 *
 *   sign-in Chromium --CONNECT host:443--> here --wss--> of-api.onlyx.ai --CONNECT--> proxy --> host
 *
 * What this process never has: the proxy's address or credentials. What it holds: the pass's
 * 45-minute session token, presented as a bearer on each upgrade. TLS runs end-to-end between the
 * browser and the site inside the stream; this code and the API both move ciphertext.
 *
 * The wire protocol is the API's (apps/api/src/modules/connect-app/tunnel.ts): the first frame the
 * server sends is text — `{"t":"ready"}` once the far end is connected, or `{"t":"error","reason"}`
 * — and everything after is binary in both directions. A close code in the 4xxx range names a
 * refusal (TUNNEL_CLOSE in messages.js).
 *
 * Only CONNECT, only to port 443, and only with the per-run proxy credentials Chromium is given
 * through Electron's `login` event: a loopback port is reachable by every process on the machine,
 * and without the password any of them could ride the creator's residential proxy for 45 minutes.
 */

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

import { TUNNEL_CLOSE } from './messages.js';

const HEAD_LIMIT = 16 * 1024;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
/** Chromium's fatal-for-the-sign-in refusals: one of these means no further stream can succeed. */
const FATAL = new Set(['unauthorized', 'proxy_auth', 'proxy_blocked', 'byte_budget']);

const reply = (socket, status, text, extra = '') => {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    /* the client is already gone */
  }
  socket.end();
};

/**
 * The request line and headers of one proxy request, or null when it is not an HTTP request head.
 * Exported for its tests; the forwarder only ever accepts the CONNECT shape.
 */
export const parseRequestHead = (text) => {
  const lines = text.split('\r\n');
  const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? '');
  if (!m) return null;
  const headers = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { method: m[1], target: m[2], headers };
};

/** `host:port` of a CONNECT target, or null. IPv6 literals arrive bracketed and are refused. */
export const parseAuthority = (target) => {
  const m = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(target ?? '');
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1].toLowerCase(), port };
};

/** What a WebSocket close, or a refused upgrade, means for the creator. */
export const reasonForClose = (code, statusText = '') => {
  if (TUNNEL_CLOSE[code]) return TUNNEL_CLOSE[code];
  if (code === 401) return 'unauthorized';
  if (code === 403) return 'target_refused';
  if (code === 429) return /byte/i.test(statusText) ? 'byte_budget' : 'too_many_streams';
  return null;
};

export const basicCredential = (username, password) =>
  `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;

/**
 * Start the forwarder. Resolves once it is listening.
 *
 * `onFatal(reason)` fires at most once, for a refusal no later stream can recover from — the caller
 * ends the sign-in and shows the creator why. Per-stream trouble (a blocked host, an idle close) is
 * counted in `stats` and otherwise left to the browser, which retries what it needs.
 */
export const startForwarder = async ({
  tunnelUrl,
  sessionToken,
  allowedPorts = [443],
  onFatal = () => {},
  log = () => {},
  WebSocketImpl = WebSocket,
} = {}) => {
  if (!tunnelUrl || !sessionToken) throw new Error('tunnelUrl and sessionToken are required');
  const auth = { username: 'onlyx', password: randomBytes(24).toString('base64url') };
  const expectedCredential = basicCredential(auth.username, auth.password);
  const stats = {
    opened: 0,
    ready: 0,
    refused: 0,
    failed: 0,
    active: 0,
    bytesUp: 0,
    bytesDown: 0,
    hosts: new Map(),
    lastReason: null,
  };
  let fatalSent = false;
  let closed = false;
  const sockets = new Set();
  const fatal = (reason) => {
    stats.lastReason = reason;
    if (fatalSent || !FATAL.has(reason)) return;
    fatalSent = true;
    onFatal(reason);
  };

  const handle = (client) => {
    sockets.add(client);
    client.setNoDelay(true);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    let head = Buffer.alloc(0);
    const onHead = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > HEAD_LIMIT) {
          stats.refused += 1;
          reply(client, 431, 'Request Header Fields Too Large');
        }
        return;
      }
      client.off('data', onHead);
      client.pause();
      const request = parseRequestHead(head.subarray(0, end).toString('latin1'));
      const rest = head.subarray(end + 4);
      head = null;
      open(client, request, rest);
    };
    client.on('data', onHead);
  };

  const open = (client, request, rest) => {
    if (!request || request.method !== 'CONNECT') {
      // A plain `GET http://...` is a request the browser would have sent in the clear. Nothing
      // in this flow is served over http, so it is refused rather than forwarded.
      stats.refused += 1;
      return reply(client, 405, 'Method Not Allowed');
    }
    if (request.headers['proxy-authorization'] !== expectedCredential) {
      stats.refused += 1;
      return reply(client, 407, 'Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="OnlyX Login"\r\n');
    }
    const authority = parseAuthority(request.target);
    if (!authority || !allowedPorts.includes(authority.port)) {
      stats.refused += 1;
      return reply(client, 403, 'Forbidden');
    }
    const { host, port } = authority;
    stats.opened += 1;
    stats.active += 1;
    stats.hosts.set(host, (stats.hosts.get(host) ?? 0) + 1);

    const url = new URL(tunnelUrl);
    url.searchParams.set('host', host);
    url.searchParams.set('port', String(port));
    const ws = new WebSocketImpl(url.toString(), {
      headers: { authorization: `Bearer ${sessionToken}` },
      perMessageDeflate: false,
      maxPayload: 4 * 1024 * 1024,
      handshakeTimeout: 20_000,
    });
    let ready = false;
    let finished = false;
    const pending = rest.length ? [rest] : [];

    const finish = (reason, { status = null } = {}) => {
      if (finished) return;
      finished = true;
      stats.active -= 1;
      if (reason) {
        stats.failed += 1;
        stats.lastReason = reason;
        log(`${host}:${port} ${reason}`);
        fatal(reason);
      }
      if (!ready && status) reply(client, status, 'Bad Gateway');
      else client.end();
      client.removeAllListeners('data');
      try {
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000);
      } catch {
        /* closing a closing socket */
      }
    };

    ws.on('unexpected-response', (_req, res) => {
      finish(reasonForClose(res.statusCode, res.statusMessage) ?? `upgrade_${res.statusCode}`, { status: 502 });
      res.resume();
    });
    ws.on('error', (err) => {
      if (finished) return;
      finish(ready ? null : `tunnel_${err?.code ?? 'error'}`, { status: 502 });
    });
    ws.on('close', (code) => {
      if (finished) return;
      const reason = reasonForClose(code);
      finish(ready ? reason : (reason ?? 'closed_before_ready'), { status: 502 });
    });
    ws.on('message', (data, isBinary) => {
      if (finished) return;
      if (!isBinary) {
        let control = null;
        try {
          control = JSON.parse(data.toString('utf8'));
        } catch {
          control = null;
        }
        if (control?.t === 'ready' && !ready) {
          ready = true;
          stats.ready += 1;
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          for (const chunk of pending.splice(0)) send(chunk);
          client.on('data', send);
          client.resume();
        } else if (control?.t === 'error') {
          finish(String(control.reason ?? 'proxy_error'), { status: 502 });
        }
        return;
      }
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      stats.bytesDown += chunk.length;
      if (!client.write(chunk)) {
        ws.pause();
        client.once('drain', () => {
          if (!finished) ws.resume();
        });
      }
    });

    const send = (chunk) => {
      if (finished) return;
      stats.bytesUp += chunk.length;
      ws.send(chunk, { binary: true }, () => {
        if (!finished && client.isPaused() && ws.bufferedAmount < LOW_WATER) client.resume();
      });
      if (ws.bufferedAmount > HIGH_WATER) client.pause();
    };

    client.on('close', () => finish(null));
    client.on('error', () => finish(null));
  };

  const server = net.createServer(handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address();
  log(`forwarder listening on 127.0.0.1:${port}`);

  return {
    port,
    auth,
    /** Chromium's proxy rules for this forwarder: every scheme, no bypass — not even loopback. */
    proxyConfig: { proxyRules: `http=127.0.0.1:${port};https=127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' },
    stats,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
};

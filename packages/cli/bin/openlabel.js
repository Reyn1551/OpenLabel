#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sirv from 'sirv';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, '..', 'dist');
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string', default: '0.0.0.0' },
    'no-open': { type: 'boolean', default: false },
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`openlabel ${pkg.version}

Usage: openlabel [options]

  -p, --port <n>   Port to listen on (default: 4173, else the next free one)
      --host <h>   Host to bind (default: 0.0.0.0, so paired devices can reach it;
                   use 127.0.0.1 to keep it on this machine only)
      --no-open    Do not open the browser
  -v, --version    Print version
  -h, --help       Print this help

Your projects live in this browser origin. Use the same port to see them again.`);
  process.exit(0);
}
if (values.version) {
  console.log(pkg.version);
  process.exit(0);
}

const explicitPort = values.port !== undefined;
const port = explicitPort ? Number.parseInt(values.port, 10) : 4173;
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`openlabel: invalid --port "${values.port}"`);
  process.exit(1);
}
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('openlabel: bundled dist/ is missing. Reinstall the package.');
  process.exit(1);
}

// Hashed files under /assets are immutable; the shell and service worker must revalidate.
const serve = sirv(DIST, {
  single: 'index.html',
  etag: true,
  setHeaders(res, pathname) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    const immutable = pathname.startsWith('/assets/') && /-[\w-]{8}\./.test(pathname);
    res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
});

/**
 * LAN rendezvous for pairing.
 *
 * WebRTC needs an offer and an answer, so a link that needs no reply has to put
 * the answer somewhere both devices can reach. Each `npx openlabel` instance
 * acts as that meeting point for its own network: the host posts an offer, the
 * guest posts an answer, and each side polls the other's instance. Nothing
 * leaves the LAN and no third-party service is involved. Only SDP text is
 * stored, held in memory, and dropped after ten minutes.
 */
const ROOM_TTL_MS = 10 * 60 * 1000;
const MAX_SIGNAL_BYTES = 256 * 1024;
const rooms = new Map();

function pruneRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [id, room] of rooms) {
    if (room.updatedAt < cutoff) rooms.delete(id);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_SIGNAL_BYTES) {
        reject(new Error('Signal payload too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  // The guest page runs on a different origin (its own localhost port), so the
  // rendezvous has to allow it. Only SDP is exposed, and only for ten minutes.
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Forwards a rendezvous request to another instance on the LAN.
 *
 * Doing the cross-origin hop here means the page only ever talks to its own
 * origin, so the app's `connect-src 'self'` policy stays intact.
 */
async function relaySignal(req, res, roomId, relayList, search) {
  const init = { method: req.method, headers: {} };
  const body = req.method === 'POST' ? await readBody(req) : null;
  if (body !== null) {
    init.headers['content-type'] = 'application/json';
    init.body = body;
  }

  // The host can be reachable on several interfaces, so try each in turn. The
  // first one that answers wins; only a total failure is reported.
  const candidates = relayList.split(',').filter(Boolean).slice(0, 6);
  for (const candidate of candidates) {
    if (!/^[A-Za-z0-9.:\[\]-]{3,80}$/u.test(candidate)) continue;
    try {
      const response = await fetch(`http://${candidate}/__signal/${roomId}${search}`, init);
      const text = await response.text();
      if (!response.ok) continue;
      res.writeHead(response.status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(text);
      return true;
    } catch {
      // Try the next interface.
    }
  }
  sendJson(res, 502, { error: 'Cannot reach the other device.' });
  return true;
}

async function handleSignal(req, res, roomId) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const relay = url.searchParams.get('relay');
  if (relay) {
    const search = new URLSearchParams(url.searchParams);
    search.delete('relay');
    const query = search.toString();
    return relaySignal(req, res, roomId, relay, query ? `?${query}` : '');
  }

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return true;
  }
  if (!/^[A-Za-z0-9_-]{4,64}$/u.test(roomId)) {
    sendJson(res, 400, { error: 'Invalid room id.' });
    return true;
  }

  pruneRooms();
  const existing = rooms.get(roomId) ?? { updatedAt: Date.now() };

  if (req.method === 'GET') {
    const role = new URL(req.url ?? '/', 'http://localhost').searchParams.get('role');
    const payload = role === 'answer' ? existing.answer : role === 'offer' ? existing.offer : undefined;
    if (!payload) {
      sendJson(res, 404, { error: 'Not ready.' });
      return true;
    }
    sendJson(res, 200, { payload });
    return true;
  }

  if (req.method === 'POST') {
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Body must be JSON.' });
      return true;
    }
    const role = parsed?.role;
    const payload = parsed?.payload;
    if ((role !== 'offer' && role !== 'answer') || typeof payload !== 'string' || payload.length === 0) {
      sendJson(res, 400, { error: 'Expected { role, payload }.' });
      return true;
    }
    if (role === 'offer') existing.offer = payload;
    else existing.answer = payload;
    existing.updatedAt = Date.now();
    rooms.set(roomId, existing);
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 405, { error: 'Method not allowed.' });
  return true;
}

/**
 * Reports this instance's reachable addresses.
 *
 * Browsers hide local IPs behind mDNS names in the SDP, so a page cannot learn
 * "where am I on the LAN" by inspecting a WebRTC candidate. The CLI can: it asks
 * the OS. That is what makes a one-click link work on the same network.
 */
function localAddresses() {
  const result = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      result.push(entry.address);
    }
  }
  return result;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/__info') {
    sendJson(res, 200, {
      version: pkg.version,
      port: actualPort ?? port,
      addresses: localAddresses(),
    });
    return;
  }

  const signal = /^\/__signal\/([^/?#]+)/u.exec(req.url ?? '');
  if (signal) {
    void handleSignal(req, res, signal[1]);
    return;
  }
  serve(req, res);
});

// The app stores data per origin, so the default port stays stable. If it is
// taken, only an explicit --port fails; the default walks forward to a free one
// and prints the URL it chose.
const FALLBACK_ATTEMPTS = 20;
let actualPort = null;

function listen(portToTry, attemptsLeft) {
  function onListening() {
    server.off('error', onError);
    actualPort = server.address()?.port ?? portToTry;
    const host = ['0.0.0.0', '::'].includes(values.host) ? 'localhost' : values.host;
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${actualPort}/`;
    const moved = !explicitPort && actualPort !== port;
    console.log(`
  OpenLabel ${pkg.version} · local-first image annotation studio
  ${url}
${moved ? `\n  Port ${port} was busy, so OpenLabel chose ${actualPort}.\n  Projects are stored per origin. Free ${port} to reopen work saved there.\n` : ''}
  Data stays in this browser (IndexedDB). Come back to this exact URL.
  Ctrl+C to stop.`);
    if (!values['no-open']) openBrowser(url);
  }
  function onError(err) {
    server.off('listening', onListening);
    if (err.code === 'EADDRINUSE' && !explicitPort && attemptsLeft > 0) {
      listen(portToTry + 1, attemptsLeft - 1);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      console.error(`openlabel: port ${portToTry} is already in use.
Your projects are stored per origin (http://localhost:${portToTry}); switching ports looks empty.
Free the port, or pick another one:  openlabel --port 5173`);
    } else if (err.code === 'EACCES') {
      console.error(`openlabel: cannot bind ${values.host}:${portToTry}; try --port 9173.`);
    } else {
      console.error(`openlabel: ${err.message}`);
    }
    process.exit(1);
  }
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(portToTry, values.host);
}

listen(port, explicitPort ? 0 : FALLBACK_ATTEMPTS);

function openBrowser(url) {
  if (!process.stdout.isTTY || process.env.CI) return;
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // No browser available; the URL is already printed.
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

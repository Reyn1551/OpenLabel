#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
    host: { type: 'string', default: '127.0.0.1' },
    'no-open': { type: 'boolean', default: false },
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`openlabel ${pkg.version}

Usage: openlabel [options]

  -p, --port <n>   Port to listen on (default: 4173, else the next free one)
      --host <h>   Host to bind (default: 127.0.0.1)
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

const server = createServer((req, res) => serve(req, res));

// The app stores data per origin, so the default port stays stable. If it is
// taken, only an explicit --port fails; the default walks forward to a free one
// and prints the URL it chose.
const FALLBACK_ATTEMPTS = 20;

function listen(portToTry, attemptsLeft) {
  function onListening() {
    server.off('error', onError);
    const actualPort = server.address()?.port ?? portToTry;
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

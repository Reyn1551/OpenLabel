# Installation

OpenLabel is a **static single-page app with no backend**. There is no database
to provision and no data to upload — every project, image, and model lives in
the browser's IndexedDB on the machine that created it. "Installing" means
serving the built `dist/` over HTTP(S); the container is just a convenient,
reproducible way to do that.

You have three options, in order of how much you want to manage:

| Option | When to use | You run |
| --- | --- | --- |
| **Container** (recommended) | A team or a machine that should "just work" | `docker run` or `docker compose up` |
| **Static host** | You already run nginx/Caddy/S3 | copy `dist/` |
| **GitHub Pages** | A personal demo, no team | already configured in this repo |

---

## 1. Container (recommended)

The image is published to GitHub Container Registry on every push to `main`
and on every `v*` tag, for `linux/amd64` and `linux/arm64`. It is a
multi-stage build: Node builds the app, then `nginx-unprivileged` serves it as a
non-root user (uid 101) on port 8080.

### One-liner

```bash
docker run -d \
  --name openlabel \
  --restart unless-stopped \
  -p 8080:8080 \
  ghcr.io/reyn1551/openlabel:latest
```

Then open <http://localhost:8080>. `localhost` is a **secure context**, so the
service worker, clipboard, and "Install app" all work.

### Hardened one-liner

The image is already non-root and read-only-friendly. To lock it down:

```bash
docker run -d \
  --name openlabel \
  --restart unless-stopped \
  -p 8080:8080 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  ghcr.io/reyn1551/openlabel:latest
```

`--read-only` works because the unprivileged base writes only to `/tmp` (pid,
temp paths) and logs to stdout/stderr.

### Compose

```bash
git clone https://github.com/Reyn1551/OpenLabel.git
cd OpenLabel
docker compose up -d          # http://localhost:8080
```

`docker-compose.yml` already sets `read_only`, `tmpfs`, `cap_drop: ALL`,
`no-new-privileges`, and a `/healthz` healthcheck. Pin a version instead of
`latest` for a stable install:

```bash
OPENLABEL_TAG=0.1.0 docker compose up -d
```

### Upgrading and rolling back

```bash
docker compose pull && docker compose up -d     # upgrade
docker tag ghcr.io/reyn1551/openlabel:0.1.0 openlabel:rollback
OPENLABEL_TAG=rollback docker compose up -d     # roll back
```

Because the app is stateless, there is no migration step. Data lives in each
user's browser, not in the container.

### HTTPS for a public hostname

```bash
OPENLABEL_HOST=labels.example.com docker compose --profile tls up -d
```

This adds a Caddy container that obtains and renews a certificate automatically
and proxies to the app.

### LAN-only (no public DNS)

```bash
OPENLABEL_HOST=openlabel.local CADDYFILE=docker/Caddyfile.internal \
  docker compose --profile tls up -d
```

This uses Caddy's `tls internal` (a self-signed local CA). **Each client must
trust that CA** or the browser treats the origin as non-secure and disables the
service worker and clipboard. To trust it:

```bash
# copy the CA out of the Caddy container
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
# install it into the OS/browser trust store, then reload the page
```

For a quick test without trusting the CA, Chrome can be started with
`--unsafely-treat-insecure-origin-as-stable="https://openlabel.local"` — testing
only, not a real deployment.

### Why HTTPS matters here

`localhost`/`127.0.0.1` is a secure context. A LAN IP over plain HTTP is **not**,
and browsers will:

- refuse to register the service worker (no offline / PWA install),
- block `navigator.clipboard` (invite codes can't be copied — the app falls
  back to a select-and-copy path and shows a hint),
- in some browsers, restrict WebRTC.

So for multi-device use, use the TLS profile above.

### Air-gapped / offline install

```bash
# on a machine with internet
docker pull ghcr.io/reyn1551/openlabel:latest
docker save ghcr.io/reyn1551/openlabel:latest | gzip > openlabel.tar.gz
# copy openlabel.tar.gz to the target, then
docker load < openlabel.tar.gz
docker run -d -p 8080:8080 ghcr.io/reyn1551/openlabel:latest
```

### Healthcheck

`GET /healthz` returns `200 ok` and is wired into the image's `HEALTHCHECK` and
the compose `healthcheck`. It is excluded from access logs.

---

## 2. Static host

Build and copy the output:

```bash
npm ci
npm run build          # writes dist/
# copy dist/ to your web root
```

The nginx config used by the container (`docker/nginx.conf`) is a good reference
for any host. The two things that matter:

1. **SPA fallback** — unknown paths return `index.html`:
   ```nginx
   location / { try_files $uri $uri/ /index.html; }
   ```
2. **Caching** — hashed `/assets/*` are immutable for a year; `index.html` and
   `sw.js` are `no-cache`. The container sets this from a single `map` so the
   security headers are never dropped by a nested `add_header`.

The content security policy the app is built against (and the container
enforces) is:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
media-src 'self' blob:; font-src 'self' data:; connect-src 'self';
worker-src 'self' blob:; manifest-src 'self'; base-uri 'self';
form-action 'self'; frame-ancestors 'none'
```

`'wasm-unsafe-eval'` is required for the Rust feature engine; `blob:` for the
worker and image previews.

---

## 3. GitHub Pages

Already configured: the `Deploy (GitHub Pages)` workflow builds on every push to
`main` and serves the site at the repository's Pages URL. Set `VITE_BASE` to the
project path if you are not using the default `/` base.

---

## What "no upload" means for a deployment

- The container serves **static files only**. It never stores, proxies, or logs
  user data. Point it at a reverse proxy and it stays stateless.
- Team collaboration is **peer-to-peer WebRTC** between the users' browsers.
  The container is not in that path; there is no signaling server.
- Backing up a project is a user action (export), not a server action.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Blank page on a LAN IP | Non-secure origin. Use the TLS profile or trust the local CA. |
| Invite code won't copy | Clipboard needs a secure context. The app falls back to select-and-copy; prefer HTTPS. |
| App looks stale after upgrade | The service worker. Reload once (it auto-updates), or unregister + clear storage to force. |
| `docker compose` can't reach the app | Confirm the healthcheck passes: `docker compose ps` should show `(healthy)`. |
| Port already in use | Change the host port: `-p 9000:8080` or `OPENLABEL_PORT=9000`. |

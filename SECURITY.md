# Security Policy

## Local-first threat model

OpenLabel has no backend, no account system, and no telemetry. The application
is a static bundle that runs in the user's browser. That design removes a whole
class of server-side risks, but it does not make the application automatically
safe. The relevant trust boundaries are:

1. **The browser origin** — application code and any script that manages to run
   in the origin can read the IndexedDB database, including images and labels.
2. **Imported files** — images and any future project import are untrusted
   input. The browser's image decoders and the application's own parsers are the
   attack surface.
3. **The static host and service worker** — a compromised host, a malicious
   update, or a cross-origin script can replace the application or exfiltrate
   local data.
4. **The device and browser profile** — a shared, compromised, or
   extension-heavy browser profile can access local data outside the
   application's control.

### What the application stores

All project data lives in the origin-scoped IndexedDB database `openlabel`:
project settings, image metadata, image and thumbnail blobs, annotations,
dataset versions, and model bundles. Export files are generated in memory and
downloaded through the browser. Nothing is uploaded by the application.

### Threats considered in review

- **Untrusted image parsing.** A malicious or malformed image can target the
  browser's decoder, or exhaust memory and storage with huge dimensions,
  decompression bombs, or many files. Images are decoded locally; there is no
  server-side sandbox or malware scanner. Users should only open files they
  would open in any other local image application. Resource-exhaustion issues
  that can be triggered by a plausible file are treated as bugs.
- **Cross-site scripting (XSS).** Class names, image names, annotation
  attributes, and project descriptions are user-controlled. They must be
  rendered as text, never as HTML. A successful XSS payload runs with the
  application's origin and can read or alter every local project. UI changes
  must not introduce `dangerouslySetInnerHTML`, HTML-string rendering, or
  untrusted URL construction.
- **Export injection.** CSV and spreadsheet exports can turn user-controlled
  strings into formulas when opened in Excel or similar tools. Exporters should
  neutralize cells that begin with formula sigils (`=`, `+`, `-`, `@`) unless
  the format explicitly requires them, and should never emit executable content.
- **User-initiated URL import.** The optional URL import fetches the requested
  URL directly in the browser. The remote host sees the request (including the
  user's IP address and headers) and can return arbitrary bytes. There is no
  proxy or server-side scanner. Only import URLs you trust, and remember that
  CORS and network failures are reported as import errors rather than bypassed.
- **Storage isolation.** IndexedDB is scoped by origin. A different port,
  scheme, or hostname is a different database. Clearing site data, private
  browsing, or browser cleanup can permanently delete projects. OpenLabel
  cannot recover data the browser has removed; users must export backups.
- **Service worker updates.** The PWA caches the application shell. A
  compromised static host or a malicious service-worker update could serve
  modified code. Self-hosters should use HTTPS, control write access to the
  deployed origin, and avoid injecting third-party scripts.
- **Dependency and supply-chain risk.** The project uses an npm lockfile, CI
  installs with `npm ci`, and CodeQL runs on pushes, pull requests, and a weekly
  schedule. Review dependency additions; the auto-label engine is intentionally
  dependency-free.

### Out of scope

- An attacker who already controls the device, the browser process, an
  extension with page access, or the user's operating-system account.
- Data recovery after the user clears browser storage.
- Vulnerabilities in the browser's built-in image decoders that are not
  reachable through OpenLabel's use of the platform.
- Denial of service caused by intentionally opening an unreasonably large
  dataset on a device without the memory or storage to handle it, unless the
  application can prevent the failure with reasonable validation.
- Social engineering, physical access, and compromised release infrastructure.

These exclusions do not mean reports are unwelcome. If you are unsure whether an
issue is in scope, report it privately and let the maintainers triage it.

### Deployment hardening

OpenLabel does not ship a server configuration. If you self-host it:

- Serve the app over HTTPS.
- Add a Content Security Policy that disallows inline and third-party scripts
  where your build permits it.
- Do not add analytics, session replay, or third-party embeds to the app origin;
  they would inherit access to local project data.
- Keep dependencies and the host platform patched.
- Use a dedicated browser profile for sensitive datasets, and export backups
  before clearing site data.

---

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include the affected version or commit, browser and OS, a description of the
   impact, reproduction steps, and a minimal proof of concept when possible.

If private reporting is unavailable, contact the maintainers through their
GitHub profiles and ask for a private channel. Do not include exploit details in
a public issue, discussion, or pull request.

Please remove private images, labels, and dataset contents from reports. If a
reproduction requires a file, use a synthetic or redacted sample.

### What to expect

- **Acknowledgment:** best effort within 3 business days.
- **Triage:** an initial assessment within 10 business days.
- **Updates:** we will keep you informed of progress and ask for clarification
  when needed.
- **Disclosure:** we aim to coordinate disclosure within 90 days of the report,
  sooner when a fix is available. We will credit reporters who want credit.
- **Fixes:** security fixes are prioritized over feature work and are released
  as soon as practical.

Please act in good faith: do not access, modify, or exfiltrate data that does
not belong to you, and do not degrade service for other users. Good-faith
research on your own data and local deployments is welcome.

---

## Supported versions

OpenLabel is pre-1.0. Security fixes are provided for:

| Version | Supported |
| --- | --- |
| Latest release (0.x) | Yes |
| `main` branch | Yes, for issues fixed before the next release |
| Older 0.x releases | No; upgrade to the latest release |

There are no long-term-support branches before 1.0. When a vulnerability affects
an older release, the advisory will state the fixed version and any available
mitigation.

---

## Security-related configuration

- The auto-label worker is an execution and responsiveness boundary, not a
  security sandbox. Code running in the worker has the same origin privileges as
  the page.
- Model bundles are data, not executable code. Treat a model bundle from an
  untrusted source as untrusted input: inference must validate dimensions and
  format versions rather than trusting array lengths.
- Exported files inherit the sensitivity of the source dataset. Store and share
  them accordingly.
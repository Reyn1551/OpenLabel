# openlabel

Local-first image annotation studio. Runs entirely in your browser — no account,
no server, no upload.

```bash
npx openlabel
```

That's it. It serves the app at `http://localhost:4173` and opens your browser.
Your projects live in that browser's IndexedDB, so come back to the same URL.

## Options

```
openlabel [options]

  -p, --port <n>   Port to listen on (default: 4173)
      --host <h>   Host to bind (default: 127.0.0.1)
      --no-open    Do not open the browser
  -v, --version    Print version
  -h, --help       Print this help
```

Serve to other machines on your network:

```bash
openlabel --host 0.0.0.0 --port 4173
```

Each browser origin keeps its own data, so a second machine gets its own
projects — that is the model, not a bug.

## Install it once

`npx` caches the package after the first run, so subsequent starts are instant.
If you want it as a command:

```bash
npm install -g openlabel
openlabel
```

## Why not Docker?

`npx openlabel` needs Node ≥ 20 on the host and is the fastest way to try the
tool. Use the [Docker image](https://github.com/Reyn1551/OpenLabel) when the
host has no Node runtime, or when the app must be pinned and audited as an image
(air-gapped / regulated environments).

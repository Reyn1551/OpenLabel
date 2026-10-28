# openlabel

Local-first image annotation studio. Runs entirely in your browser. No account,
no server, no upload.

```bash
npx openlabel
```

That's it. It serves the app on port 4173 and opens your browser. If 4173 is
taken, it moves to the next free port and prints the URL. Your projects live in
that browser's IndexedDB, so come back to the same URL.

## Options

```
openlabel [options]

  -p, --port <n>   Port to listen on (default: 4173, else the next free one)
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
projects. That is the model, not a bug.

## Install it as a command

`npx` caches the package after the first run, so later starts are instant. To
get a permanent `openlabel` command:

```bash
npm install -g openlabel
openlabel
```

The `-g` flag is required. Without it, npm links the binary into the local
`node_modules/.bin`, which your shell does not see.

## Ports

The app prefers 4173. If that port is busy, it steps forward until it finds a
free one and prints the URL it chose. Projects are stored per origin, so use the
same port to reopen earlier work; free 4173 if you want the data saved there.

## Why not Docker?

`npx openlabel` needs Node ≥ 20 on the host and is the fastest way to try the
tool. Use the [Docker image](https://github.com/Reyn1551/OpenLabel) when the
host has no Node runtime, or when the app must be pinned and audited as an image
(air-gapped / regulated environments).

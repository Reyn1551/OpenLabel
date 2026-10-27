# Performance

Measured with Lighthouse 13.5 against the production build served by
`vite preview` on localhost. Mobile is the default preset (simulated slow 4G,
4× CPU); desktop is `--preset=desktop`.

```bash
npm run build
npx vite preview --port 4189 --strictPort
npx lighthouse http://127.0.0.1:4189/ --quiet --output=json --output-path=/tmp/lh.json
npx lighthouse http://127.0.0.1:4189/ --preset=desktop --quiet --output=json --output-path=/tmp/lh-desktop.json
```

## Results

| Category | Mobile before | Mobile after | Desktop after |
| --- | ---: | ---: | ---: |
| Performance | 96 | 98 | **100** |
| Accessibility | 100 | 100 | **100** |
| Best practices | 100 | 100 | **100** |
| SEO | 100 | 100 | **100** |

| Metric (mobile) | Before | After |
| --- | ---: | ---: |
| First Contentful Paint | 1.9 s | 0.8 s |
| Largest Contentful Paint | 2.5 s | 2.3 s |
| Speed Index | 1.9 s | 0.8 s |
| Total Blocking Time | 10–30 ms | 20–30 ms |
| Cumulative Layout Shift | 0 | 0 |

## Bundle

| Asset | Before | After |
| --- | --- | --- |
| entry JS | 461 kB (147 kB gz) | 68 kB (22 kB gz) |
| `vendor-react` (React 19 + router) | — | 259 kB (82 kB gz) |
| `vendor-ui` (Radix + floating-ui) | — | 136 kB (45 kB gz) |
| landing route chunk | in entry | 5.7 kB (2 kB gz), `modulepreload`ed |
| entry CSS | 34 kB, render-blocking request | inlined into `index.html` (7 kB gz) |

## Changes

1. **react-router production build.** react-router 7 exports
   `dist/development` for every condition, so the production bundle carried the
   dev-warning build. The build now resolves `react-router` and
   `react-router/dom` to `dist/production/*`; the dev server keeps warnings.
2. **Single-file CSS inlined.** One 34 kB stylesheet blocked first paint on a
   second round trip. A build-only plugin inlines it into `index.html`.
3. **Vendor chunking + modulepreload.** React/router and the Radix layer are
   separate chunks fetched in parallel, and the landing route chunk is
   preloaded from the document. The modulepreload polyfill is disabled.
4. **Static shell in `index.html`.** The document paints the same loading state
   that the React tree would, so first paint no longer waits for the module
   graph.
5. **Service worker after idle.** Precaching the whole app shell used to start
   during page load and compete with the scripts that paint the first screen.

## Why mobile performance is not 100

Largest Contentful Paint is the dashboard header, which only exists after React
mounts. On the simulated slow-4G profile, ~150 kB gzip of framework code costs
about 1.5 s of download and execution; desktop has no throttling and scores 100.

Two measured options remain, both larger than a tuning change:

- **Prerender the landing route.** Server-render the shell at build time and
  hydrate it. This needs an SSR build of the app and a hydration-safe initial
  state (the dashboard currently starts from an async IndexedDB read).
- **Swap the framework.** A Preact-compat build measured
  `vendor-react` at 22 kB gz instead of 82 kB and lifted mobile performance to
  99 (LCP 1.8 s), but the existing Playwright suite fails against it today
  (the app never mounts), so adopting it would be a migration, not a config
  flag. It is recorded here as evidence, not as a shipped change.

Everything else the app ships with — the annotation studio, auto-label engine,
exports, and collaboration — stays in route chunks and is not on the landing
critical path.
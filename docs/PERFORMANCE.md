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
| Performance | 96 | **100** | **100** |
| Accessibility | 100 | **100** | **100** |
| Best practices | 100 | **100** | **100** |
| SEO | 100 | **100** | **100** |

| Metric (mobile) | Before | After |
| --- | ---: | ---: |
| First Contentful Paint | 1.9 s | 0.6 s |
| Largest Contentful Paint | 2.5 s | 1.9 s |
| Speed Index | 1.9 s | 0.6 s |
| Total Blocking Time | 10–30 ms | 10–30 ms |
| Cumulative Layout Shift | 0 | 0 |

Two consecutive local runs produced identical scores; the desktop run reports
LCP 0.4 s.

The deployed site (`https://reyn1551.github.io/OpenLabel/`, GitHub Pages, real
network) also scores **100 / 100 / 100 / 100** on the mobile preset: FCP 1.0 s,
LCP 1.7 s, Speed Index 1.3 s, TBT 50 ms, CLS 0, TTFB 270 ms. Accessibility, best practices, and SEO stay at 100 in every run, and the
Playwright suite runs axe on the dashboard, studio, mobile studio, and team
screens.

## Bundle

| Asset | Before | After |
| --- | --- | --- |
| entry JS | 461 kB (147 kB gz) | 67 kB (22 kB gz) |
| `vendor-react` (Preact compat + router) | — | 60 kB (22 kB gz) |
| `vendor-ui` (Radix + floating-ui) | — | 131 kB (44 kB gz) |
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
6. **Preact compatibility layer.** `react`, `react-dom`, and the JSX runtimes
   resolve to `preact/compat` (see `vite.config.ts`). React 19 plus the router
   was 82 kB gzip on the critical path; the compatibility layer is 22 kB, which
   is what moved mobile performance from 98 to 100 and also cut the e2e suite
   from ~29 s to ~21 s. The full Playwright suite (annotation, auto-label
   training, export, dialogs, menus, two-tab collaboration, axe on four screens)
   runs against it; a React A/B build scored 98 with the same markup.
7. **Radix is a lazy chunk.** The Radix-backed controls (dialog, menu, select,
   slider, tabs, switch, progress, tooltip) live in `src/ui/heavy.tsx`, a
   separate chunk that the entry and the dashboard do not import statically.
   The app shell uses plain buttons, and the dashboard only mounts its
   `Dialog`/`Menu` when the user opens them, so `vendor-ui` (44 kB gzip) is not
   fetched on first paint. The studio, which uses all of them, loads the chunk
   on its own route. `Tooltip` is self-contained (it carries its own provider)
   so no page needs a global `TooltipProvider`.

## Headroom

`vendor-ui` (44 kB gzip) is off the landing path but still loads on the studio
route. Splitting the Radix primitives further (e.g. a per-control lazy chunk)
would shrink the studio's initial fetch, at the cost of more round trips while
the studio is opening. It is tracked as future work rather than shipped untested.

Everything else the app ships with — the annotation studio, auto-label engine,
exports, and collaboration — stays in route chunks and is not on the landing
critical path.

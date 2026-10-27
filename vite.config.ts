import { defineConfig } from 'vitest/config';
import type { Plugin, Rollup } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

const isAsset = (file: Rollup.OutputAsset | Rollup.OutputChunk): file is Rollup.OutputAsset =>
  file.type === 'asset';

// react-router 7 ships both builds but its exports map only points at
// dist/development, so production bundles would otherwise carry the
// ENABLE_DEV_WARNINGS branch. Only the build is redirected; the dev server keeps
// the warnings.
const reactRouterAliases = [
  { find: /^react-router\/dom$/, replacement: `${root}node_modules/react-router/dist/production/dom-export.mjs` },
  { find: /^react-router$/, replacement: `${root}node_modules/react-router/dist/production/index.mjs` },
];

/**
 * Inlines the single emitted stylesheet into index.html so first paint no longer
 * waits on a second round trip. `enforce: 'post'` puts this after Vite's HTML
 * plugin and after vite-plugin-pwa's generateBundle, so the produced HTML is final
 * and the precache glob (generated from disk in closeBundle) never sees the CSS.
 */
function inlineStylesheet(): Plugin {
  return {
    name: 'openlabel:inline-stylesheet',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const assets = Object.values(bundle).filter(isAsset);
      const html = assets.find((file) => file.fileName === 'index.html');
      if (!html || typeof html.source !== 'string') return;

      const stylesheets = assets.filter((file) => file.fileName.endsWith('.css'));
      if (stylesheets.length !== 1) return;

      const css = stylesheets[0];
      const name = css.fileName.split('/').pop() ?? '';
      const link = new RegExp(`\\s*<link rel="stylesheet"[^>]*href="[^"]*${name}"[^>]*>`);
      if (!link.test(html.source)) return;

      const text = typeof css.source === 'string' ? css.source : Buffer.from(css.source).toString('utf8');
      html.source = html.source.replace(link, `\n    <style>${text}</style>`);
      delete bundle[css.fileName];
      delete bundle[`${css.fileName}.map`];
    },
  };
}

/**
 * The app opens on the dashboard, but its route chunk is only discovered after the
 * entry bundle executes. Preloading that one chunk from the document overlaps its
 * download with the entry graph; other routes stay lazily loaded.
 */
function preloadLandingRoute(): Plugin {
  let base = '/';
  return {
    name: 'openlabel:preload-landing-route',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      base = config.base;
    },
    generateBundle(_options, bundle) {
      const html = Object.values(bundle)
        .filter(isAsset)
        .find((file) => file.fileName === 'index.html');
      const landing = Object.values(bundle).find(
        (file): file is Rollup.OutputChunk => file.type === 'chunk' && file.name === 'DashboardPage',
      );
      if (!html || typeof html.source !== 'string' || !landing) return;
      const href = `${base}${landing.fileName}`.replace(/\/+/g, '/');
      const tag = `<link rel="modulepreload" crossorigin href="${href}">`;
      if (html.source.includes(href)) return;
      html.source = html.source.replace('</head>', `  ${tag}\n  </head>`);
    },
  };
}

export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE ?? '/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'robots.txt', 'logo-light.svg', 'logo-dark.svg', 'og.png'],
      manifest: {
        name: 'OpenLabel — local-first annotation studio',
        short_name: 'OpenLabel',
        description:
          'Annotate a handful of images, then let few-shot auto-labeling finish the dataset. Runs entirely on your device.',
        theme_color: '#0b0d12',
        background_color: '#0b0d12',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
    inlineStylesheet(),
    preloadLandingRoute(),
  ],
  resolve: {
    alias: [
      // Preact's compatibility layer: same React API, ~60 kB less JavaScript at
      // runtime. See docs/PERFORMANCE.md for the measurement and the e2e guard.
      { find: /^react$/, replacement: 'preact/compat' },
      { find: /^react-dom$/, replacement: 'preact/compat' },
      { find: /^react-dom\/client$/, replacement: 'preact/compat/client' },
      { find: /^react\/jsx-runtime$/, replacement: 'preact/jsx-runtime' },
      { find: /^react\/jsx-dev-runtime$/, replacement: 'preact/jsx-dev-runtime' },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      ...(command === 'build' ? reactRouterAliases : []),
    ],
  },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // Independent vendor chunks let the browser fetch the framework and the
        // Radix layer in parallel with app code instead of one 460 kB request.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          // `preact` is aliased to `react`, so it must be grouped with the
          // framework chunk. If it landed in the Radix chunk instead, the entry
          // (which imports the JSX runtime) would pull the whole Radix bundle
          // onto first paint.
          if (/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|preact)\//.test(id)) {
            return 'vendor-react';
          }
          if (/node_modules\/(@radix-ui|@floating-ui|aria-hidden|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|use-callback-ref|use-sidecar|detect-node-es|get-nonce|@babel\/runtime|tslib)\//.test(id)) {
            return 'vendor-ui';
          }
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/unit/setup.ts'],
    css: false,
  },
}));

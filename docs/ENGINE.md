# The feature engine: Rust → WebAssembly, with a JavaScript reference

OpenLabel's few-shot detector has one pixel-bound stage: turning an image into
cell statistics and turning a rectangle into a 50-value descriptor. Everything
else — the linear softmax, NMS, box fusion, metrics — is small and stays in
TypeScript.

That pixel stage is written twice:

| Implementation | File | Role |
| --- | --- | --- |
| TypeScript | `src/autolabel/features.ts` | reference, fallback for engines without WebAssembly |
| Rust → wasm32 | `engine/src/lib.rs` | default path in the auto-label worker |

Both produce the same numbers. `tests/unit/engine-parity.test.ts` fails the build
if they drift, and CI rebuilds the module from source in the `engine` job.

## Why Rust and not Go

The engine has to run **inside the page**, on devices the user already owns, with
no install step. That rules out a native daemon and points at WebAssembly.

Go's wasm target ships a runtime and GC (megabytes before any user code); Rust
with `opt-level = "z"`, fat LTO and `panic = "abort"` produces a **23 KiB**
module with no imports. On a weak device, download size and instantiation time
matter as much as throughput.

The ABI is hand-written (`#[no_mangle] extern "C"`), so there is no bindgen
toolchain in the build and no JS glue to keep in sync: `src/autolabel/engine.ts`
owns the few pointer calls.

## What actually got faster

Two changes, measured with `npx vite-node scripts/bench-engine.ts` on a
768×576 image and 5 000 rectangles (one machine, warm cache):

| Stage | Before | After |
| --- | --- | --- |
| Grid build, JavaScript reference | 46.3 ms | 26.0 ms |
| Grid build, WebAssembly | 70.0 ms | 20.9 ms |
| 5 000 descriptors, JavaScript | 17.7 ms | 19.0 ms |
| 5 000 descriptors, WebAssembly | 24.3 ms | 16.3 ms |
| Module size | — | 23 KiB |

The first win was **algorithmic, not linguistic**. The original code called
`Math.atan2` and `Math.hypot` once per pixel just to pick one of eight
orientation bins. Neither has a WebAssembly instruction, so the module was
slower than V8's intrinsics. Replacing the angle computation with comparisons
against `tan(k·π/8)` — verified equivalent over three million random gradients —
cut the JavaScript path by 44% and made the wasm path viable. Magnitude uses
`sqrt` (a hardware instruction) instead of `hypot`.

The second win was removing bounds checks in the compiled inner loops; every
index in the pixel pass and the summed-area lookup is clamped by construction.

WebAssembly is now ~1.2× faster than the JavaScript reference for both stages.
That is a modest margin on a fast desktop and a larger one on engines with a
weaker JIT — which is the case the engine exists for.

## Memory: one image at a time

Training used to build a feature grid for **every** image and keep them all
while sampling descriptors. A grid is ~3.6 MB per level and there are two levels,
so 100 images held roughly 700 MB — enough to kill a phone or a 4 GB laptop.

`buildDescriptorSamples` and the validation folds now build a grid, sample it,
and release it (`releaseGrid`, which frees the engine handle). Peak memory is one
image plus its two levels, independent of dataset size. A 5 000-image project
runs with the same footprint as a 50-image one.

## Failure behaviour

`ensureEngine()` in the worker is best-effort:

1. fetch the hashed `.wasm` asset;
2. instantiate and install it as the feature backend;
3. on any failure, log once and continue with the JavaScript reference.

An old browser, a blocked asset, or a host without WebAssembly therefore loses
speed, never functionality. The module is precached by the service worker, so
offline sessions use it too.

## Building

```bash
# requires a Rust toolchain with the wasm32 target
rustup target add wasm32-unknown-unknown
npm run build:engine     # cargo build --release --target wasm32-unknown-unknown, then copy
npm run test             # includes the parity suite
npx vite-node scripts/bench-engine.ts
```

`src/autolabel/engine.wasm` is committed so `npm run build` works without Rust;
CI rebuilds it from `engine/` and re-runs the parity suite, so a stale artifact
or a source-only change cannot slip through.
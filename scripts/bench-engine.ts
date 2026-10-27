/**
 * Engine benchmark: JavaScript reference vs the WebAssembly module.
 *
 * Run with `npx vite-node scripts/bench-engine.ts` after `npm run build:engine`.
 * Numbers are indicative (single machine, warm cache); the committed table in
 * docs/ENGINE.md records one measured run so claims stay traceable.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildCellGridJs,
  descriptorJs,
  mulberry32,
  type RGBAImage,
  type Rect,
} from '../src/autolabel/features';
import { instantiateEngine } from '../src/autolabel/engine';

const wasmPath = fileURLToPath(new URL('../src/autolabel/engine.wasm', import.meta.url));

function fixture(width: number, height: number): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const rand = mulberry32(7);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      data[o] = Math.round((x / width) * 200 + rand() * 40);
      data[o + 1] = Math.round((y / height) * 160 + rand() * 40);
      data[o + 2] = Math.round(120 + rand() * 60);
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

function time(label: string, iterations: number, run: () => void): number {
  run();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) run();
  const elapsed = performance.now() - started;
  console.log(`${label}: ${(elapsed / iterations).toFixed(2)} ms/iteration (${iterations} runs)`);
  return elapsed / iterations;
}

const image = fixture(768, 576);
const rects: Rect[] = [];
const rand = mulberry32(99);
for (let index = 0; index < 5000; index += 1) {
  const width = 16 + rand() * 120;
  const height = 16 + rand() * 120;
  rects.push({ x: rand() * (image.width - width), y: rand() * (image.height - height), width, height });
}

const engine = await instantiateEngine(readFileSync(wasmPath));

const jsGrid = time('grid (JS)', 3, () => {
  buildCellGridJs(image, 4);
});
time('grid (WASM)', 3, () => {
  engine.release(engine.buildCellGrid(image, 4));
});

const reference = buildCellGridJs(image, 4);
const jsDescribe = time('5000 descriptors (JS)', 3, () => {
  for (const rect of rects) descriptorJs(reference, rect);
});

const accelerated = engine.buildCellGrid(image, 4);
const wasmDescribe = time('5000 descriptors (WASM)', 3, () => {
  engine.descriptors(accelerated, rects);
});

console.log('');
console.log(`grid speedup: ${(jsGrid / Math.max(0.001, time('grid (WASM, repeat)', 1, () => engine.release(engine.buildCellGrid(image, 4))))).toFixed(2)}x`);
console.log(`descriptor speedup: ${(jsDescribe / wasmDescribe).toFixed(2)}x`);
console.log(`wasm module: ${(readFileSync(wasmPath).length / 1024).toFixed(1)} KiB`);
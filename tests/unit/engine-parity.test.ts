// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CELL_PLANES,
  DESCRIPTOR_DIM,
  buildCellGridJs,
  descriptorJs,
  mulberry32,
  setFeatureBackend,
  buildCellGrid,
  descriptor,
  type RGBAImage,
  type Rect,
} from '@/autolabel/features';
import { instantiateEngine, type WasmEngine } from '@/autolabel/engine';

/**
 * The WASM engine must reproduce the JavaScript reference. Both are shipped, and
 * a user may fall back to JavaScript at any time (old browser, blocked module),
 * so a divergence would silently change model scores.
 *
 * Tolerance is absolute 1e-4 per value: the reference accumulates in float32 and
 * the module uses the same widths, leaving only transcendental rounding.
 */

const wasmPath = fileURLToPath(new URL('../../src/autolabel/engine.wasm', import.meta.url));

function fixture(width: number, height: number): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const rand = mulberry32(1234);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const base = (x / width) * 180 + (y / height) * 60;
      data[o] = Math.round(base + rand() * 20);
      data[o + 1] = Math.round(140 - (x / width) * 80 + rand() * 15);
      data[o + 2] = Math.round(90 + (y / height) * 100 + rand() * 10);
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

function maxDelta(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  for (let index = 0; index < a.length; index += 1) {
    worst = Math.max(worst, Math.abs(a[index] - b[index]));
  }
  return worst;
}

const rects: Rect[] = [
  { x: 4, y: 4, width: 32, height: 24 },
  { x: 0, y: 0, width: 96, height: 64 },
  { x: 40.5, y: 12.25, width: 20.75, height: 33.5 },
  { x: 90, y: 60, width: 6, height: 4 },
  { x: 10, y: 10, width: 2, height: 60 },
];

describe('wasm engine parity', () => {
  it('matches the reference cell grid and integrals', async () => {
    const engine: WasmEngine = await instantiateEngine(readFileSync(wasmPath));
    const image = fixture(96, 64);

    const reference = buildCellGridJs(image, 4);
    const accelerated = engine.buildCellGrid(image, 4);

    expect(accelerated.gw).toBe(reference.gw);
    expect(accelerated.gh).toBe(reference.gh);
    for (let plane = 0; plane < CELL_PLANES; plane += 1) {
      expect(maxDelta(accelerated.planes[plane], reference.planes[plane])).toBeLessThan(1e-4);
      // Integrals sum hundreds of cells and reach ~1e5, so an absolute 1e-4
      // bound would only measure float32 addition order. 1e-2 is 4e-8 relative.
      expect(maxDelta(accelerated.integral[plane], reference.integral[plane])).toBeLessThan(1e-2);
    }

    engine.release(accelerated);
  });

  it('produces the same descriptors as the reference', async () => {
    const engine = await instantiateEngine(readFileSync(wasmPath));
    const image = fixture(96, 64);
    const reference = buildCellGridJs(image, 4);
    const accelerated = engine.buildCellGrid(image, 4);

    const expected = engine.descriptors(accelerated, rects);
    expect(expected).toHaveLength(rects.length);

    rects.forEach((rect, index) => {
      const baseline = descriptorJs(reference, rect);
      expect(baseline).not.toBeNull();
      expect(expected[index]).toHaveLength(DESCRIPTOR_DIM);
      expect(maxDelta(expected[index], baseline!)).toBeLessThan(1e-4);
    });

    engine.release(accelerated);
  });

  it('returns null for degenerate rectangles through the backend seam', async () => {
    const engine = await instantiateEngine(readFileSync(wasmPath));
    const image = fixture(32, 32);
    setFeatureBackend(engine);
    try {
      const grid = buildCellGrid(image, 4);
      expect(grid.engine).toBe('wasm');
      expect(descriptor(grid, { x: 4, y: 4, width: 0, height: 0 })).toBeNull();
      expect(descriptor(grid, { x: 4, y: 4, width: 10, height: 10 })).not.toBeNull();
    } finally {
      setFeatureBackend(null);
    }
  });

  it('frees grid handles so a long session does not grow memory without bound', async () => {
    const engine = await instantiateEngine(readFileSync(wasmPath));
    const image = fixture(64, 64);
    for (let round = 0; round < 40; round += 1) {
      const grid = engine.buildCellGrid(image, 4);
      expect(engine.descriptor(grid, { x: 8, y: 8, width: 24, height: 24 })).not.toBeNull();
      engine.release(grid);
    }
  });
});
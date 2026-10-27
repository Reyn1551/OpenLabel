/**
 * Dense cell features + sliding-window descriptors for the few-shot detector.
 *
 * The whole approach is deliberately dependency-free and deterministic:
 *  1. Aggregated per-cell color and gradient statistics are computed once per
 *     image scale (cheap, one pass over pixels).
 *  2. Summed-area tables turn any rectangle into a 12-value cell average in
 *     O(1), so a proposal descriptor costs 16 * 12 lookups regardless of size.
 *  3. Descriptors are L2-normalized and fed to a linear softmax classifier,
 *     which is what makes ten annotations enough to train in a second.
 */

export interface RGBAImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export const ORIENT_BINS = 8;
export const CELL_PLANES = 3 + ORIENT_BINS + 1; // L, a, b, orientation bins, magnitude

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CellGrid {
  /** Number of feature cells horizontally / vertically. */
  gw: number;
  gh: number;
  cell: number;
  /** Source image size in pixels. */
  width: number;
  height: number;
  /** Per-plane cell values, length gw*gh. */
  planes: Float32Array[];
  /** Per-plane summed-area table, length (gw+1)*(gh+1). */
  integral: Float32Array[];
  /** Backend that produced the grid; absent means the JavaScript reference. */
  engine?: 'js' | 'wasm';
  /** Engine handle for wasm grids. */
  handle?: number;
}

/**
 * Optional accelerated implementation of the pixel-bound pass.
 *
 * `features.ts` stays the reference: the backend must produce the same numbers,
 * and every consumer works unchanged with either one.
 */
export interface FeatureBackend {
  buildCellGrid(image: RGBAImage, cell: number): CellGrid;
  descriptor(grid: CellGrid, rect: Rect, out?: Float32Array): Float32Array | null;
  descriptors?(grid: CellGrid, rects: Rect[]): Float32Array[];
  release?(grid: CellGrid): void;
}

let backend: FeatureBackend | null = null;

export function setFeatureBackend(next: FeatureBackend | null): void {
  backend = next;
}

export function featureBackend(): FeatureBackend | null {
  return backend;
}

export function buildCellGrid(img: RGBAImage, cell = 4): CellGrid {
  return backend ? backend.buildCellGrid(img, cell) : buildCellGridJs(img, cell);
}

export function descriptor(grid: CellGrid, rect: Rect, out?: Float32Array): Float32Array | null {
  return backend ? backend.descriptor(grid, rect, out) : descriptorJs(grid, rect, out);
}

/** Batch form used by the proposal loop; collapses boundary calls. */
export function descriptors(grid: CellGrid, rects: Rect[]): (Float32Array | null)[] {
  if (!backend) return rects.map((rect) => descriptorJs(grid, rect));
  if (backend.descriptors) return backend.descriptors(grid, rects);
  return rects.map((rect) => backend!.descriptor(grid, rect));
}

/** Frees engine-side storage; a no-op for the JavaScript reference. */
export function releaseGrid(grid: CellGrid): void {
  backend?.release?.(grid);
}

const clampInt = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

// tan(k * PI / 8) for the interior bin boundaries. Comparing against these
// constants replaces atan2 with a handful of multiplications/divisions: atan2
// has no wasm instruction, so every pixel paid a software call for a value that
// only feeds an 8-way bucket.
const TAN_1 = 0.41421356237309503; // tan(PI/8)
const TAN_2 = 1;
const TAN_3 = 2.414213562373095; // tan(3PI/8)

/**
 * Unsigned orientation bin for a gradient vector.
 *
 * Equivalent to `atan2(gy, gx)` normalized into [0, PI) and split into eight
 * equal buckets, which is the definition used by the reference descriptors.
 */
export function orientationBin(gx: number, gy: number): number {
  let dx = gx;
  let dy = gy;
  if (dx === 0) return 4;
  if (dx < 0) {
    dx = -dx;
    dy = -dy;
  }
  const ratio = dy / dx;
  if (ratio < -TAN_3) return 4;
  if (ratio < -TAN_2) return 5;
  if (ratio < -TAN_1) return 6;
  if (ratio < 0) return 7;
  if (ratio < TAN_1) return 0;
  if (ratio < TAN_2) return 1;
  if (ratio < TAN_3) return 2;
  return 3;
}

export function buildCellGridJs(img: RGBAImage, cell = 4): CellGrid {
  const gw = Math.max(1, Math.ceil(img.width / cell));
  const gh = Math.max(1, Math.ceil(img.height / cell));
  const count = gw * gh;
  const planes = Array.from({ length: CELL_PLANES }, () => new Float32Array(count));
  const [pL, pA, pB, ...rest] = planes;
  const magPlane = rest[ORIENT_BINS];
  const counts = new Float32Array(count);
  const data = img.data;

  const lum = new Float32Array(img.width * img.height);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  for (let y = 0; y < img.height; y++) {
    const cellY = Math.floor(y / cell);
    for (let x = 0; x < img.width; x++) {
      const o = y * img.width + x;
      const p = o * 4;
      const idx = cellY * gw + Math.floor(x / cell);
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      pL[idx] += 0.299 * r + 0.587 * g + 0.114 * b;
      pA[idx] += r - g;
      pB[idx] += 0.5 * (r + g) - b;
      counts[idx] += 1;

      const xm = x > 0 ? x - 1 : x;
      const xp = x < img.width - 1 ? x + 1 : x;
      const ym = y > 0 ? y - 1 : y;
      const yp = y < img.height - 1 ? y + 1 : y;
      const gx = (lum[y * img.width + xp] - lum[y * img.width + xm]) * 0.5;
      const gy = (lum[yp * img.width + x] - lum[ym * img.width + x]) * 0.5;
      const mag = Math.sqrt(gx * gx + gy * gy);
      // Unsigned orientation keeps descriptors stable under horizontal flips.
      const bin = orientationBin(gx, gy);
      rest[bin][idx] += mag;
      magPlane[idx] += mag;
    }
  }

  // One division per cell: the color planes are already inside `planes`, so
  // dividing them separately would scale L/a/b down twice and mute color.
  for (let i = 0; i < count; i++) {
    const c = counts[i] || 1;
    for (const plane of planes) plane[i] /= c;
  }

  const integral = planes.map((plane) => buildIntegral(plane, gw, gh));
  return { gw, gh, cell, width: img.width, height: img.height, planes, integral };
}

export function buildIntegral(plane: Float32Array, gw: number, gh: number): Float32Array {
  const out = new Float32Array((gw + 1) * (gh + 1));
  for (let y = 0; y < gh; y++) {
    let rowSum = 0;
    for (let x = 0; x < gw; x++) {
      rowSum += plane[y * gw + x];
      out[(y + 1) * (gw + 1) + (x + 1)] = out[y * (gw + 1) + (x + 1)] + rowSum;
    }
  }
  return out;
}

export function integralRect(integral: Float32Array, gw: number, x0: number, y0: number, x1: number, y1: number): number {
  const stride = gw + 1;
  const a = y0 * stride;
  const b = y1 * stride;
  return integral[b + x1] - integral[a + x1] - integral[b + x0] + integral[a + x0];
}

/**
 * A rectangle in image pixels. Grid coordinates are clamped, so proposals that
 * cross the border are scored on their visible portion.
 */
function rectToCells(grid: CellGrid, rect: Rect): { x0: number; y0: number; x1: number; y1: number } | null {
  const x0 = clampInt(Math.floor(rect.x / grid.cell), 0, grid.gw);
  const y0 = clampInt(Math.floor(rect.y / grid.cell), 0, grid.gh);
  const x1 = clampInt(Math.ceil((rect.x + rect.width) / grid.cell), 0, grid.gw);
  const y1 = clampInt(Math.ceil((rect.y + rect.height) / grid.cell), 0, grid.gh);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

/** Descriptor geometry: SUB x SUB sub-cells, each contributing 12 values. */
export const SUB = 4;
export const DESCRIPTOR_DIM = SUB * SUB * CELL_PLANES + 2;

/**
 * Computes a descriptor for `rect` (image pixel space) using precomputed cells.
 * The last two dimensions encode log aspect and log relative area, which give
 * the classifier a cheap shape prior.
 */
export function descriptorJs(grid: CellGrid, rect: Rect, out?: Float32Array): Float32Array | null {
  const cells = rectToCells(grid, rect);
  if (!cells) return null;
  const dim = DESCRIPTOR_DIM;
  const result = out ?? new Float32Array(dim);
  result.fill(0);
  const { x0, y0, x1, y1 } = cells;
  const spanX = x1 - x0;
  const spanY = y1 - y0;

  for (let sy = 0; sy < SUB; sy++) {
    const ry0 = y0 + (spanY * sy) / SUB;
    const ry1 = sy === SUB - 1 ? y1 : y0 + (spanY * (sy + 1)) / SUB;
    const iy0 = clampInt(Math.floor(ry0), y0, y1);
    const iy1 = clampInt(Math.max(iy0 + 1, Math.ceil(ry1)), y0, y1);
    for (let sx = 0; sx < SUB; sx++) {
      const rx0 = x0 + (spanX * sx) / SUB;
      const rx1 = sx === SUB - 1 ? x1 : x0 + (spanX * (sx + 1)) / SUB;
      const ix0 = clampInt(Math.floor(rx0), x0, x1);
      const ix1 = clampInt(Math.max(ix0 + 1, Math.ceil(rx1)), x0, x1);
      const area = (ix1 - ix0) * (iy1 - iy0) || 1;
      const base = (sy * SUB + sx) * CELL_PLANES;

      result[base] = integralRect(grid.integral[0], grid.gw, ix0, iy0, ix1, iy1) / area / 255 - 0.5;
      result[base + 1] = integralRect(grid.integral[1], grid.gw, ix0, iy0, ix1, iy1) / area / 510;
      result[base + 2] = integralRect(grid.integral[2], grid.gw, ix0, iy0, ix1, iy1) / area / 510;

      let histSum = 0;
      for (let bin = 0; bin < ORIENT_BINS; bin++) {
        const value = integralRect(grid.integral[3 + bin], grid.gw, ix0, iy0, ix1, iy1) / area / 255;
        result[base + 3 + bin] = value;
        histSum += value;
      }
      const inv = histSum > 1e-6 ? 1 / histSum : 0;
      for (let bin = 0; bin < ORIENT_BINS; bin++) result[base + 3 + bin] *= inv;
      const mag = integralRect(grid.integral[3 + ORIENT_BINS], grid.gw, ix0, iy0, ix1, iy1) / area / 255;
      result[base + 3 + ORIENT_BINS] = Math.log1p(mag * 8);
    }
  }

  const aspect = Math.log(Math.max(1e-3, rect.width) / Math.max(1e-3, rect.height));
  const relative = Math.log(Math.max(1e-6, (rect.width * rect.height) / (grid.width * grid.height)));
  result[dim - 2] = aspect / 4;
  result[dim - 1] = relative / 8;

  let norm = 0;
  for (let i = 0; i < dim; i++) norm += result[i] * result[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) result[i] /= norm;
  return result;
}

/** Rescales a rectangle between image-space scales. */
export function scaleRect(rect: Rect, factor: number): Rect {
  return {
    x: rect.x * factor,
    y: rect.y * factor,
    width: rect.width * factor,
    height: rect.height * factor,
  };
}

export function normalizeRect(rect: Rect): Rect {
  const x = rect.width < 0 ? rect.x + rect.width : rect.x;
  const y = rect.height < 0 ? rect.y + rect.height : rect.y;
  return { x, y, width: Math.abs(rect.width), height: Math.abs(rect.height) };
}

export function rectIoU(a: Rect, b: Rect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Deterministic PRNG so training is reproducible for the same dataset. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
import type { Point } from './types';
import { simplifyPolygon } from './geometry';
import { largestComponentMask, traceMaskContour } from '@/autolabel/mask';
import type { RGBAImage } from '@/autolabel/features';

/**
 * Magic-wand selection: flood fills a color-similar region around the seed
 * point, keeps the largest connected component, fills holes, and returns a
 * simplified polygon in the pixel space of the supplied image.
 */
export function magicWandPolygon(img: RGBAImage, seed: Point, tolerance = 24): Point[] {
  const { width, height, data } = img;
  const sx = Math.max(0, Math.min(width - 1, Math.round(seed.x)));
  const sy = Math.max(0, Math.min(height - 1, Math.round(seed.y)));
  const seedOffset = (sy * width + sx) * 4;
  const seedR = data[seedOffset];
  const seedG = data[seedOffset + 1];
  const seedB = data[seedOffset + 2];
  const threshold = tolerance * tolerance * 3;
  const mask = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const start = sy * width + sx;
  stack[tail++] = start;
  mask[start] = 1;
  while (head < tail) {
    const index = stack[head++];
    const x = index % width;
    const y = (index / width) | 0;
    const neighbors = [
      x > 0 ? index - 1 : -1,
      x < width - 1 ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y < height - 1 ? index + width : -1,
    ];
    for (const next of neighbors) {
      if (next < 0 || mask[next]) continue;
      const o = next * 4;
      const dr = data[o] - seedR;
      const dg = data[o + 1] - seedG;
      const db = data[o + 2] - seedB;
      if (dr * dr + dg * dg + db * db > threshold) continue;
      mask[next] = 1;
      stack[tail++] = next;
    }
  }
  const filled = largestComponentMask(mask, width, height);
  let count = 0;
  for (const value of filled) count += value;
  if (count < 16) return [];
  const contour = traceMaskContour(filled, width, height);
  if (contour.length < 3) return [];
  return simplifyPolygon(contour, Math.max(1, Math.round(Math.min(width, height) * 0.002)));
}

/** Downscales RGBA pixels so interactive tools stay responsive on huge images. */
export function downscaleForSelection(img: RGBAImage, maxSide = 1280): { image: RGBAImage; scale: number } {
  const longSide = Math.max(img.width, img.height);
  if (longSide <= maxSide) return { image: img, scale: 1 };
  const scale = maxSide / longSide;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const from = (sy * img.width + sx) * 4;
      const to = (y * w + x) * 4;
      out[to] = img.data[from];
      out[to + 1] = img.data[from + 1];
      out[to + 2] = img.data[from + 2];
      out[to + 3] = 255;
    }
  }
  return { image: { data: out, width: w, height: h }, scale };
}
import type { Point } from '@/core/types';
import { simplifyPolygon } from '@/core/geometry';
import type { Rect, RGBAImage } from './features';

/**
 * Box → polygon refinement for instance-segmentation projects.
 *
 * A GrabCut-lite pass: pixels are assigned to a foreground/background color
 * model seeded by the box interior and its border, the largest connected
 * component is kept, holes are filled, and the boundary is traced and
 * simplified. This is classical CV, so it runs instantly and never downloads a
 * segmentation model.
 */
export function refineBoxToPolygon(img: RGBAImage, box: Rect, maxSide = 192): Point[] {
  const padding = Math.round(Math.min(box.width, box.height) * 0.06) + 2;
  const x0 = Math.max(0, Math.floor(box.x - padding));
  const y0 = Math.max(0, Math.floor(box.y - padding));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.width + padding));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.height + padding));
  const cropW = x1 - x0;
  const cropH = y1 - y0;
  if (cropW < 6 || cropH < 6) return boxCorners(box);

  const scale = Math.min(1, maxSide / Math.max(cropW, cropH));
  const w = Math.max(4, Math.round(cropW * scale));
  const h = Math.max(4, Math.round(cropH * scale));
  const crop = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, y0 + Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, x0 + Math.floor(x / scale));
      const p = (sy * img.width + sx) * 4;
      const o = (y * w + x) * 3;
      crop[o] = img.data[p];
      crop[o + 1] = img.data[p + 1];
      crop[o + 2] = img.data[p + 2];
    }
  }

  const boxInCrop = {
    x: (box.x - x0) * scale,
    y: (box.y - y0) * scale,
    width: box.width * scale,
    height: box.height * scale,
  };

  const fg = meanColor(crop, w, h, boxInCrop, 0.6);
  const bg = borderMean(crop, w, h);
  const colors = new Float32Array(6 * 3);
  colors.set(fg, 0);
  colors.set(bg, 3);

  const mask = new Uint8Array(w * h);
  const inner = {
    x0: Math.max(0, Math.floor(boxInCrop.x)),
    y0: Math.max(0, Math.floor(boxInCrop.y)),
    x1: Math.min(w, Math.ceil(boxInCrop.x + boxInCrop.width)),
    y1: Math.min(h, Math.ceil(boxInCrop.y + boxInCrop.height)),
  };
  for (let y = inner.y0; y < inner.y1; y++) {
    for (let x = inner.x0; x < inner.x1; x++) {
      const o = (y * w + x) * 3;
      const df = colorDistance(crop, o, fg);
      const db = colorDistance(crop, o, bg);
      if (df * 1.05 < db) mask[y * w + x] = 1;
    }
  }

  fillHoles(mask, w, h);
  const largest = largestComponentMask(mask, w, h);
  const area = largest.reduce((sum, v) => sum + v, 0);
  if (area < (inner.x1 - inner.x0) * (inner.y1 - inner.y0) * 0.12) return boxCorners(box);

  const contour = traceMaskContour(largest, w, h);
  if (contour.length < 6) return boxCorners(box);
  const scaleX = cropW / w;
  const scaleY = cropH / h;
  const points = contour.map((p) => ({ x: x0 + p.x * scaleX, y: y0 + p.y * scaleY }));
  const simplified = simplifyPolygon(points, Math.max(1.2, (box.width + box.height) * 0.004));
  return simplified.length >= 3 ? simplified : boxCorners(box);
}

function boxCorners(box: Rect): Point[] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
}

function meanColor(
  crop: Float32Array,
  w: number,
  h: number,
  box: Rect,
  fraction: number,
): [number, number, number] {
  const cw = box.width * fraction;
  const ch = box.height * fraction;
  const cx = box.x + (box.width - cw) / 2;
  const cy = box.y + (box.height - ch) / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.max(0, Math.floor(cy)); y < Math.min(h, Math.ceil(cy + ch)); y++) {
    for (let x = Math.max(0, Math.floor(cx)); x < Math.min(w, Math.ceil(cx + cw)); x++) {
      const o = (y * w + x) * 3;
      r += crop[o];
      g += crop[o + 1];
      b += crop[o + 2];
      n += 1;
    }
  }
  if (n === 0) return [128, 128, 128];
  return [r / n, g / n, b / n];
}

function borderMean(crop: Float32Array, w: number, h: number): [number, number, number] {
  const ring = Math.max(1, Math.round(Math.min(w, h) * 0.08));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= ring && x < w - ring && y >= ring && y < h - ring) continue;
      const o = (y * w + x) * 3;
      r += crop[o];
      g += crop[o + 1];
      b += crop[o + 2];
      n += 1;
    }
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

function colorDistance(crop: Float32Array, offset: number, color: [number, number, number]): number {
  const dr = crop[offset] - color[0];
  const dg = crop[offset + 1] - color[1];
  const db = crop[offset + 2] - color[2];
  return dr * dr + dg * dg + db * db;
}

function fillHoles(mask: Uint8Array, w: number, h: number): void {
  const reachable = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) {
    stack.push(x, (h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    stack.push(y * w, y * w + w - 1);
  }
  while (stack.length) {
    const index = stack.pop()!;
    if (reachable[index] || mask[index]) continue;
    reachable[index] = 1;
    const x = index % w;
    const y = (index / w) | 0;
    if (x > 0) stack.push(index - 1);
    if (x < w - 1) stack.push(index + 1);
    if (y > 0) stack.push(index - w);
    if (y < h - 1) stack.push(index + w);
  }
  for (let i = 0; i < mask.length; i++) if (!mask[i] && !reachable[i]) mask[i] = 1;
}

export function largestComponentMask(mask: Uint8Array, w: number, h: number): Uint8Array {
  const labels = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  let current = 0;
  const queue = new Int32Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i] >= 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    labels[i] = current;
    let size = 0;
    while (head < tail) {
      const index = queue[head++];
      size += 1;
      const x = index % w;
      const y = (index / w) | 0;
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x < w - 1 ? index + 1 : -1,
        y > 0 ? index - w : -1,
        y < h - 1 ? index + w : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && mask[n] && labels[n] < 0) {
          labels[n] = current;
          queue[tail++] = n;
        }
      }
    }
    sizes.push(size);
    current += 1;
  }
  const out = new Uint8Array(w * h);
  if (sizes.length === 0) return out;
  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
  for (let i = 0; i < labels.length; i++) if (labels[i] === best) out[i] = 1;
  return out;
}

/** Moore-neighbor boundary tracing, returning contour points clockwise. */
export function traceMaskContour(mask: Uint8Array, w: number, h: number): Point[] {
  let start = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const dirs = [
    [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];
  const points: Point[] = [];
  let cx = start % w;
  let cy = (start / w) | 0;
  let dir = 7;
  const limit = w * h * 4;
  for (let step = 0; step < limit; step++) {
    points.push({ x: cx, y: cy });
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 7 + k) % 8;
      const nx = cx + dirs[(d + 1) % 8][0];
      const ny = cy + dirs[(d + 1) % 8][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) continue;
      cx = nx;
      cy = ny;
      dir = (d + 1) % 8;
      found = true;
      break;
    }
    if (!found) break;
    if (cx === start % w && cy === ((start / w) | 0) && points.length > 3) break;
  }
  // Keep every other point to reduce the vertex count before simplification.
  return points.filter((_, index) => index % 2 === 0 || index === points.length - 1);
}
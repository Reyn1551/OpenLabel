import { describe, expect, it } from 'vitest';
import { largestComponentMask, traceMaskContour, refineBoxToPolygon } from '@/autolabel/mask';
import { polygonArea } from '@/core/geometry';
import { magicWandPolygon } from '@/core/segment';

function rectMask(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * w + x] = 1;
  return mask;
}

describe('mask tracing', () => {
  it('traces a filled square with the right perimeter and area', () => {
    const w = 40;
    const h = 40;
    const mask = rectMask(w, h, 5, 6, 35, 36);
    const contour = traceMaskContour(mask, w, h);
    expect(contour.length).toBeGreaterThanOrEqual(100);
    expect(polygonArea(contour)).toBeGreaterThan(26 * 26);
    expect(polygonArea(contour)).toBeLessThan(32 * 32);
    for (const point of contour) {
      expect(point.x).toBeGreaterThanOrEqual(4.5);
      expect(point.x).toBeLessThanOrEqual(35.5);
      expect(point.y).toBeGreaterThanOrEqual(5.5);
      expect(point.y).toBeLessThanOrEqual(36.5);
    }
  });

  it('ignores holes and returns the outer boundary', () => {
    const w = 40;
    const h = 40;
    const mask = rectMask(w, h, 5, 5, 35, 35);
    for (let y = 17; y < 23; y++) for (let x = 17; x < 23; x++) mask[y * w + x] = 0;
    const contour = traceMaskContour(mask, w, h);
    expect(polygonArea(contour)).toBeGreaterThan(700);
  });

  it('keeps only the largest connected component', () => {
    const w = 20;
    const h = 20;
    const mask = rectMask(w, h, 1, 1, 4, 4);
    for (let y = 10; y < 18; y++) for (let x = 10; x < 18; x++) mask[y * w + x] = 1;
    const largest = largestComponentMask(mask, w, h);
    let count = 0;
    for (const value of largest) count += value;
    expect(count).toBe(64);
  });
});

function syntheticImage(): { data: Uint8ClampedArray; width: number; height: number } {
  const width = 120;
  const height = 120;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inside = Math.hypot(x - 60, y - 60) <= 30;
      data[o] = inside ? 230 : 25;
      data[o + 1] = inside ? 40 : 35;
      data[o + 2] = inside ? 60 : 45;
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('box prompting', () => {
  it('turns a box around a disc into a polygon close to the disc', () => {
    const image = syntheticImage();
    const polygon = refineBoxToPolygon(image, { x: 20, y: 20, width: 80, height: 80 });
    const area = polygonArea(polygon);
    const discArea = Math.PI * 30 * 30;
    expect(area).toBeGreaterThan(discArea * 0.55);
    expect(area).toBeLessThan(discArea * 1.6);
    expect(polygon.length).toBeGreaterThanOrEqual(6);
  });

  it('falls back to box corners when the box has no structure', () => {
    const image = syntheticImage();
    const polygon = refineBoxToPolygon(image, { x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(polygon.length).toBe(4);
  });
});

describe('magic wand', () => {
  it('segments a uniform background region', () => {
    const width = 80;
    const height = 80;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const inside = x >= 30 && x < 50 && y >= 30 && y < 50;
        data[o] = inside ? 240 : 20;
        data[o + 1] = inside ? 30 : 60;
        data[o + 2] = inside ? 40 : 200;
        data[o + 3] = 255;
      }
    }
    const polygon = magicWandPolygon({ data, width, height }, { x: 5, y: 5 }, 20);
    const area = polygonArea(polygon);
    expect(area).toBeGreaterThan(4800);
    expect(area).toBeLessThan(6600);
  });
});

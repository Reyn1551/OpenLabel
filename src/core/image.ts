/**
 * Image decoding and compact visual descriptors.
 *
 * Everything here runs on the main thread or in a worker through the same
 * functions; the only platform dependency is `createImageBitmap` + canvas.
 */

export interface DecodedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export async function decodeImage(source: Blob): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
  return { bitmap, width: bitmap.width, height: bitmap.height };
}

export function drawToCanvas(
  source: CanvasImageSource,
  width: number,
  height: number,
): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, width, height);
    return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return { canvas, ctx };
}

export async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type = 'image/webp',
  quality = 0.82,
): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Failed to encode thumbnail'))), type, quality);
  return promise;
}

export async function makeThumbnail(source: CanvasImageSource, maxSize = 352): Promise<Blob> {
  const { width, height } = sourceSize(source);
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const { canvas } = drawToCanvas(source, w, h);
  return canvasToBlob(canvas, 'image/webp', 0.8);
}

function sourceSize(source: CanvasImageSource): { width: number; height: number } {
  if (source instanceof ImageBitmap) return { width: source.width, height: source.height };
  if ('width' in source && 'height' in source) {
    return { width: Number(source.width), height: Number(source.height) };
  }
  throw new Error('Unsupported image source');
}

/** 32x32 grayscale sample used by the perceptual hash and descriptors. */
function sampleGray(source: CanvasImageSource, size = 32): Float32Array {
  const { ctx } = drawToCanvas(source, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const gray = new Float32Array(size * size);
  for (let i = 0; i < gray.length; i++) {
    const o = i * 4;
    gray[i] = (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114) / 255;
  }
  return gray;
}

/** 8x8 DCT-II (orthonormal) of the 32x32 grayscale sample. */
export function dct8(gray: Float32Array, size = 32): Float32Array {
  const out = new Float32Array(64);
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          sum +=
            gray[x * size + y] *
            Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size)) *
            Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size));
        }
      }
      const cu = u === 0 ? Math.SQRT1_2 : 1;
      const cv = v === 0 ? Math.SQRT1_2 : 1;
      out[u * 8 + v] = 0.25 * cu * cv * sum;
    }
  }
  return out;
}

/** 64-bit perceptual hash as 16 hex chars; robust to scaling and recompression. */
export async function computePHash(source: CanvasImageSource): Promise<string> {
  const gray = sampleGray(source);
  const coeffs = dct8(gray).slice(1); // drop DC
  const sorted = Array.from(coeffs).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    hash = (hash << 1n) | (coeffs[i] > median ? 1n : 0n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a || '0'}`) ^ BigInt(`0x${b || '0'}`);
  let count = 0;
  while (x) {
    x &= x - 1n;
    count += 1;
  }
  return count;
}

/**
 * 92-dimension global descriptor: 4x4 Lab-ish color means (48),
 * gradient orientation histogram (8), gradient energy per quadrant (16),
 * plus aspect ratio and brightness (2). L2 normalized per block so that
 * cosine similarity behaves sensibly across differently lit photos.
 */
export async function computeDescriptor(source: CanvasImageSource): Promise<number[]> {
  const size = 48;
  const { ctx } = drawToCanvas(source, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const color = new Float32Array(48);
  const gradHist = new Float32Array(8);
  const energy = new Float32Array(16);
  const lum = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    lum[i] = (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114) / 255;
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cell = Math.floor(y / 12) * 4 + Math.floor(x / 12);
      const o = (y * size + x) * 4;
      color[cell * 3] += data[o] / 255;
      color[cell * 3 + 1] += data[o + 1] / 255;
      color[cell * 3 + 2] += data[o + 2] / 255;
      const gx = (lum[Math.min(size - 1, x + 1) + y * size] - lum[Math.max(0, x - 1) + y * size]) * 0.5;
      const gy = (lum[x + Math.min(size - 1, y + 1) * size] - lum[x + Math.max(0, y - 1) * size]) * 0.5;
      const mag = Math.hypot(gx, gy);
      const angle = Math.atan2(gy, gx);
      const bin = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * 8) % 8;
      gradHist[bin] += mag;
      energy[Math.floor(y / 12) * 4 + Math.floor(x / 12)] += mag;
    }
  }
  const norm = (arr: Float32Array): number[] => {
    let sum = 0;
    for (const v of arr) sum += v * v;
    const n = Math.sqrt(sum) || 1;
    return Array.from(arr, (v) => v / n);
  };
  const aspect = sourceSize(source).width / sourceSize(source).height;
  let meanLum = 0;
  for (const v of lum) meanLum += v;
  return [...norm(color), ...norm(gradHist), ...norm(energy), Math.min(2, aspect) / 2, meanLum / lum.length];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

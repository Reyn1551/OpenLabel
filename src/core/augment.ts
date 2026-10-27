/**
 * Preprocessing and augmentation for dataset export.
 *
 * Every geometric operation here is expressed in *source image pixel space* so
 * exporters can map annotations without touching the DOM. Pixel operations are
 * isolated in `renderPreprocessed` / `renderAugmented`, which need a canvas.
 *
 * Transform order for an augmented variant is:
 *   preprocess (resize/letterbox) → horizontal flip → vertical flip → rotate 90°
 *   → photometric operations.
 * Photometric operations never change geometry. Flips are applied inside the
 * preprocessed frame, then the 90° rotation swaps that frame's dimensions.
 */

import { clamp, clampGeometryToImage, rotateGeometry, scaleGeometry, translateGeometry } from './geometry';
import type { AugmentationConfig, Geometry, PreprocessConfig } from './types';
import { canvasToBlob } from './image';

/** How an image's pixels map from source space into its preprocessed frame. */
export interface PreprocessLayout {
  /** Output frame width in pixels. */
  width: number;
  /** Output frame height in pixels. */
  height: number;
  scaleX: number;
  scaleY: number;
  /** Left padding in the output frame (letterboxing only). */
  offsetX: number;
  /** Top padding in the output frame (letterboxing only). */
  offsetY: number;
}

/** Geometry plus the dimensions of the frame it now lives in. */
export interface GeometryAugment {
  geometry: Geometry;
  width: number;
  height: number;
}

/** Result of rendering an augmented variant. */
export interface AugmentRender {
  blob: Blob;
  width: number;
  height: number;
  /**
   * Maps geometry authored against the *source* image into the augmented
   * variant's frame. Preprocessing and every augmentation step are composed.
   */
  transform: (geometry: Geometry) => Geometry;
}

/** Result of rendering an image with preprocessing only. */
export interface PreprocessedRender {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Computes the preprocessed output frame for a source image.
 *
 * - `none` keeps the source size.
 * - `stretch` scales non-uniformly to the configured width and height.
 * - `fit` scales uniformly to fit inside the configured size and centers the
 *   content, leaving letterbox padding.
 */
export function preprocessLayout(
  sourceWidth: number,
  sourceHeight: number,
  preprocess: PreprocessConfig,
): PreprocessLayout {
  const sw = Math.max(1, sourceWidth);
  const sh = Math.max(1, sourceHeight);
  if (preprocess.resizeMode === 'none') {
    return { width: sw, height: sh, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  }
  const tw = Math.max(1, Math.round(preprocess.width));
  const th = Math.max(1, Math.round(preprocess.height));
  if (preprocess.resizeMode === 'stretch') {
    return { width: tw, height: th, scaleX: tw / sw, scaleY: th / sh, offsetX: 0, offsetY: 0 };
  }
  const scale = Math.min(tw / sw, th / sh);
  return {
    width: tw,
    height: th,
    scaleX: scale,
    scaleY: scale,
    offsetX: (tw - sw * scale) / 2,
    offsetY: (th - sh * scale) / 2,
  };
}

/**
 * Maps a geometry from source image pixels into the preprocessed frame.
 *
 * The result is clamped to the output frame, so letterbox padding can push a
 * vertex onto the image edge but never outside it.
 */
export function transformGeometryForPreprocess(
  geometry: Geometry,
  sourceWidth: number,
  sourceHeight: number,
  preprocess: PreprocessConfig,
): Geometry {
  const layout = preprocessLayout(sourceWidth, sourceHeight, preprocess);
  const scaled = scaleGeometry(geometry, layout.scaleX, layout.scaleY);
  const moved = translateGeometry(scaled, layout.offsetX, layout.offsetY);
  return clampGeometryToImage(moved, layout.width, layout.height);
}

function mirrorGeometry(geometry: Geometry, extent: number, axis: 'x' | 'y'): Geometry {
  if (geometry.kind === 'bbox') {
    if (axis === 'x') {
      return { ...geometry, x: extent - (geometry.x + geometry.width) };
    }
    return { ...geometry, y: extent - (geometry.y + geometry.height) };
  }
  return {
    ...geometry,
    points: geometry.points.map((point) =>
      axis === 'x' ? { x: extent - point.x, y: point.y } : { x: point.x, y: extent - point.y },
    ),
  };
}

/**
 * Applies the configured geometric augmentation inside a preprocessed frame.
 *
 * Flips mirror within `width`/`height`; a 90° clockwise rotation then swaps the
 * frame dimensions. Returns geometry clamped to the resulting frame.
 */
export function augmentGeometry(
  geometry: Geometry,
  width: number,
  height: number,
  config: AugmentationConfig,
): GeometryAugment {
  let current = geometry;
  let currentWidth = width;
  let currentHeight = height;
  if (config.flipHorizontal) current = mirrorGeometry(current, currentWidth, 'x');
  if (config.flipVertical) current = mirrorGeometry(current, currentHeight, 'y');
  if (config.rotate90) {
    current = rotateGeometry(current, currentWidth, currentHeight, 1);
    [currentWidth, currentHeight] = [currentHeight, currentWidth];
  }
  return {
    geometry: clampGeometryToImage(current, currentWidth, currentHeight),
    width: currentWidth,
    height: currentHeight,
  };
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyContext2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Surface {
  canvas: AnyCanvas;
  ctx: AnyContext2D;
}

function createSurface(width: number, height: number): Surface {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    ctx.imageSmoothingQuality = 'high';
    return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

/** Draws a decoded image into its preprocessed frame, honouring letterboxing. */
function drawPreprocessed(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  layout: PreprocessLayout,
  preprocess: PreprocessConfig,
): Surface {
  const { canvas, ctx } = createSurface(layout.width, layout.height);
  if (preprocess.resizeMode === 'fit') {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, layout.width, layout.height);
  }
  if (preprocess.resizeMode === 'stretch') {
    ctx.drawImage(source, 0, 0, layout.width, layout.height);
  } else {
    const dw = sourceWidth * layout.scaleX;
    const dh = sourceHeight * layout.scaleY;
    ctx.drawImage(source, layout.offsetX, layout.offsetY, dw, dh);
  }
  return { canvas, ctx };
}

/** Draws the preprocessed frame with flips and a 90° clockwise rotation applied. */
function drawAugmented(
  source: AnyCanvas,
  width: number,
  height: number,
  config: AugmentationConfig,
): Surface {
  const outWidth = config.rotate90 ? height : width;
  const outHeight = config.rotate90 ? width : height;
  const { canvas, ctx } = createSurface(outWidth, outHeight);
  ctx.save();
  if (config.rotate90) {
    ctx.translate(outWidth, 0);
    ctx.rotate(Math.PI / 2);
  }
  if (config.flipHorizontal) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  if (config.flipVertical) {
    ctx.translate(0, height);
    ctx.scale(1, -1);
  }
  ctx.drawImage(source, 0, 0, width, height);
  ctx.restore();
  return { canvas, ctx };
}

/** Converts pixels to luminance in place, preserving alpha. */
export function applyGrayscale(image: ImageData): void {
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const luma = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    data[i] = luma;
    data[i + 1] = luma;
    data[i + 2] = luma;
  }
}

/** Deterministic 32-bit PRNG (Mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blurPass(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
): void {
  const lineCount = horizontal ? height : width;
  const lineLength = horizontal ? width : height;
  const stride = horizontal ? 4 : width * 4;
  const lineStride = horizontal ? width * 4 : 4;
  const windowSize = radius * 2 + 1;
  for (let line = 0; line < lineCount; line++) {
    const base = line * lineStride;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const clamped = clamp(offset, 0, lineLength - 1);
      const o = base + clamped * stride;
      sumR += src[o];
      sumG += src[o + 1];
      sumB += src[o + 2];
    }
    for (let index = 0; index < lineLength; index++) {
      const o = base + index * stride;
      dst[o] = sumR / windowSize;
      dst[o + 1] = sumG / windowSize;
      dst[o + 2] = sumB / windowSize;
      dst[o + 3] = src[o + 3];
      const add = base + clamp(index + 1 + radius, 0, lineLength - 1) * stride;
      const remove = base + clamp(index - radius, 0, lineLength - 1) * stride;
      sumR += src[add] - src[remove];
      sumG += src[add + 1] - src[remove + 1];
      sumB += src[add + 2] - src[remove + 2];
    }
  }
}

function boxBlur(image: ImageData, radius: number): void {
  const { width, height, data } = image;
  const r = Math.round(radius);
  if (r < 1 || width < 1 || height < 1) return;
  const source = new Uint8ClampedArray(data);
  const intermediate = new Uint8ClampedArray(data.length);
  blurPass(source, intermediate, width, height, r, true);
  blurPass(intermediate, data, width, height, r, false);
}

/**
 * Applies brightness, contrast, saturation, noise and blur in place.
 *
 * The operation order is fixed and the PRNG is seeded, so identical inputs and
 * seeds always yield identical pixels. Alpha is never modified.
 */
export function applyPhotometric(data: ImageData, config: AugmentationConfig, seed: number): void {
  const pixels = data.data;
  const brightness = clamp(config.brightness, -1, 1);
  const contrast = clamp(config.contrast, -1, 1);
  const saturation = clamp(config.saturation, -1, 1);
  const noise = clamp(config.noise, 0, 1);
  const brightnessFactor = 1 + brightness;
  const contrastFactor = 1 + contrast;
  const saturationFactor = 1 + saturation;
  const rand = mulberry32(seed);

  if (brightness !== 0 || contrast !== 0 || saturation !== 0 || noise > 0) {
    for (let i = 0; i < pixels.length; i += 4) {
      let r = pixels[i];
      let g = pixels[i + 1];
      let b = pixels[i + 2];
      if (brightness !== 0) {
        r *= brightnessFactor;
        g *= brightnessFactor;
        b *= brightnessFactor;
      }
      if (contrast !== 0) {
        r = (r - 128) * contrastFactor + 128;
        g = (g - 128) * contrastFactor + 128;
        b = (b - 128) * contrastFactor + 128;
      }
      if (saturation !== 0) {
        const luma = r * 0.299 + g * 0.587 + b * 0.114;
        r = luma + (r - luma) * saturationFactor;
        g = luma + (g - luma) * saturationFactor;
        b = luma + (b - luma) * saturationFactor;
      }
      if (noise > 0) {
        // One shared offset per pixel avoids chroma speckle.
        const delta = (rand() * 2 - 1) * noise * 64;
        r += delta;
        g += delta;
        b += delta;
      }
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
    }
  }

  if (config.blur > 0) boxBlur(data, config.blur);
}

/**
 * Renders a source image with preprocessing only: resize/letterbox and optional
 * grayscale, encoded as PNG.
 */
export async function renderPreprocessed(
  blob: Blob,
  preprocess: PreprocessConfig,
): Promise<PreprocessedRender> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const layout = preprocessLayout(bitmap.width, bitmap.height, preprocess);
    const { canvas, ctx } = drawPreprocessed(bitmap, bitmap.width, bitmap.height, layout, preprocess);
    if (preprocess.grayscale) {
      const image = ctx.getImageData(0, 0, layout.width, layout.height);
      applyGrayscale(image);
      ctx.putImageData(image, 0, 0);
    }
    return {
      blob: await canvasToBlob(canvas, 'image/png'),
      width: layout.width,
      height: layout.height,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Renders one augmented variant: preprocess, then exact geometric transforms,
 * then photometric operations. Encoded as PNG.
 *
 * `transform` composes every step so annotations authored in source pixels map
 * onto the returned variant.
 */
export async function renderAugmented(
  blob: Blob,
  config: AugmentationConfig,
  seed: number,
  preprocess: PreprocessConfig,
): Promise<AugmentRender> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  try {
    const layout = preprocessLayout(sourceWidth, sourceHeight, preprocess);
    const preprocessed = drawPreprocessed(bitmap, sourceWidth, sourceHeight, layout, preprocess);
    if (preprocess.grayscale) {
      const image = preprocessed.ctx.getImageData(0, 0, layout.width, layout.height);
      applyGrayscale(image);
      preprocessed.ctx.putImageData(image, 0, 0);
    }
    const geometric = drawAugmented(preprocessed.canvas, layout.width, layout.height, config);
    const outWidth = config.rotate90 ? layout.height : layout.width;
    const outHeight = config.rotate90 ? layout.width : layout.height;
    const pixels = geometric.ctx.getImageData(0, 0, outWidth, outHeight);
    applyPhotometric(pixels, config, seed);
    geometric.ctx.putImageData(pixels, 0, 0);

    const transform = (geometry: Geometry): Geometry => {
      const preprocessedGeometry = transformGeometryForPreprocess(
        geometry,
        sourceWidth,
        sourceHeight,
        preprocess,
      );
      return augmentGeometry(preprocessedGeometry, layout.width, layout.height, config).geometry;
    };

    return {
      blob: await canvasToBlob(geometric.canvas, 'image/png'),
      width: outWidth,
      height: outHeight,
      transform,
    };
  } finally {
    bitmap.close();
  }
}
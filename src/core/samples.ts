/**
 * Deterministic synthetic demo scenes.
 *
 * The generator is intentionally self-contained: it paints a small industrial
 * scene (bolts, gears, washers) onto a canvas and returns a PNG data URL plus
 * pixel-accurate labels. All randomness comes from one seeded PRNG, so the same
 * `(count, seed)` pair always produces the same dataset on the same browser.
 * This makes the studio usable and testable without uploading anything.
 */

import { mulberry32 } from '../autolabel/features';

/** Classes drawn by the demo generator. */
export const SAMPLE_CLASSES = ['bolt', 'gear', 'washer'] as const;

type SampleClass = (typeof SAMPLE_CLASSES)[number];

/** A generated image and the boxes that describe its objects. */
export interface SampleScene {
  name: string;
  width: number;
  height: number;
  pngDataUrl: string;
  labels: {
    className: string;
    box: { x: number; y: number; width: number; height: number };
  }[];
}

interface SampleBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SCENE_WIDTH = 480;
const SCENE_HEIGHT = 360;
const MARGIN = 24;

/** Background palettes keep scenes visually varied but still industrial. */
const BACKGROUNDS: ReadonlyArray<readonly [string, string, string]> = [
  ['#12161d', '#1c2430', '#2a3442'],
  ['#101a20', '#17303a', '#264a54'],
  ['#1a1512', '#2a211b', '#3b2f26'],
  ['#141821', '#202a3a', '#33405a'],
  ['#161318', '#241d29', '#352b3d'],
];

function createCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('Sample scene generation requires a browser environment with canvas support.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = SCENE_WIDTH;
  canvas.height = SCENE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D is unavailable; cannot generate sample scenes.');
  }
  return { canvas, ctx };
}

function overlaps(a: SampleBox, b: SampleBox): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function polar(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawBackground(ctx: CanvasRenderingContext2D, random: () => number): void {
  const palette = BACKGROUNDS[Math.floor(random() * BACKGROUNDS.length)];
  const gradient = ctx.createLinearGradient(0, 0, SCENE_WIDTH, SCENE_HEIGHT);
  gradient.addColorStop(0, palette[0]);
  gradient.addColorStop(0.55, palette[1]);
  gradient.addColorStop(1, palette[2]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SCENE_WIDTH, SCENE_HEIGHT);

  // Faint workbench grid.
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= SCENE_WIDTH; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, SCENE_HEIGHT);
    ctx.stroke();
  }
  for (let y = 0; y <= SCENE_HEIGHT; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(SCENE_WIDTH, y + 0.5);
    ctx.stroke();
  }

  // Speckle texture so the background is not a flat gradient.
  for (let i = 0; i < 220; i++) {
    const x = random() * SCENE_WIDTH;
    const y = random() * SCENE_HEIGHT;
    const radius = 0.4 + random() * 2.2;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${(0.015 + random() * 0.05).toFixed(3)})`;
    ctx.fill();
  }

  const vignette = ctx.createRadialGradient(
    SCENE_WIDTH / 2,
    SCENE_HEIGHT / 2,
    Math.min(SCENE_WIDTH, SCENE_HEIGHT) * 0.25,
    SCENE_WIDTH / 2,
    SCENE_HEIGHT / 2,
    Math.max(SCENE_WIDTH, SCENE_HEIGHT) * 0.72,
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.32)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, SCENE_WIDTH, SCENE_HEIGHT);
}

function objectSize(className: SampleClass, random: () => number): { width: number; height: number } {
  switch (className) {
    case 'bolt':
      return { width: 128 + random() * 52, height: 40 + random() * 14 };
    case 'gear': {
      const size = 78 + random() * 36;
      return { width: size, height: size };
    }
    case 'washer': {
      const size = 64 + random() * 30;
      return { width: size, height: size };
    }
  }
}

function placeObject(
  className: SampleClass,
  placed: SampleBox[],
  random: () => number,
): SampleBox {
  const size = objectSize(className, random);
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  let fallback: SampleBox | null = null;
  for (let attempt = 0; attempt < 28; attempt++) {
    const box: SampleBox = {
      x: Math.round(MARGIN + random() * (SCENE_WIDTH - MARGIN * 2 - width)),
      y: Math.round(MARGIN + random() * (SCENE_HEIGHT - MARGIN * 2 - height)),
      width,
      height,
    };
    if (!fallback) fallback = box;
    const padded: SampleBox = {
      x: box.x - 12,
      y: box.y - 12,
      width: box.width + 24,
      height: box.height + 24,
    };
    if (!placed.some((other) => overlaps(padded, other))) return box;
  }
  return fallback ?? { x: MARGIN, y: MARGIN, width, height };
}

function drawBolt(ctx: CanvasRenderingContext2D, box: SampleBox): void {
  const { x, y, width, height } = box;
  const metal = ctx.createLinearGradient(0, y, 0, y + height);
  metal.addColorStop(0, '#f3f6fa');
  metal.addColorStop(0.45, '#aeb8c6');
  metal.addColorStop(1, '#59616d');

  const headRadius = height * 0.48;
  const headX = x + headRadius * 0.92;
  const headY = y + height / 2;
  ctx.fillStyle = metal;
  ctx.strokeStyle = 'rgba(15,23,42,0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const point = polar(headX, headY, headRadius, -Math.PI / 2 + (i * Math.PI) / 3);
    if (i === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const shaftX = x + headRadius * 1.24;
  const shaftY = y + height * 0.3;
  const shaftWidth = x + width - shaftX;
  const shaftHeight = height * 0.4;
  roundedRect(ctx, shaftX, shaftY, shaftWidth, shaftHeight, shaftHeight / 2);
  ctx.fill();
  ctx.stroke();

  // Thread grooves, clipped to the shaft so they never escape the label box.
  ctx.save();
  roundedRect(ctx, shaftX, shaftY, shaftWidth, shaftHeight, shaftHeight / 2);
  ctx.clip();
  ctx.strokeStyle = 'rgba(15,23,42,0.24)';
  ctx.lineWidth = 1.5;
  for (let tx = shaftX + 8; tx < x + width - 2; tx += 9) {
    ctx.beginPath();
    ctx.moveTo(tx, shaftY + 1);
    ctx.lineTo(tx - 6, shaftY + shaftHeight - 1);
    ctx.stroke();
  }
  ctx.restore();

  // Head highlight.
  ctx.beginPath();
  ctx.arc(headX - headRadius * 0.18, headY - headRadius * 0.24, headRadius * 0.26, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fill();
}

function drawGear(ctx: CanvasRenderingContext2D, box: SampleBox): void {
  const size = Math.min(box.width, box.height);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const outer = size / 2 - 1;
  const root = size * 0.35;
  const teeth = 9;
  const step = (Math.PI * 2) / teeth;

  const metal = ctx.createRadialGradient(
    cx - size * 0.16,
    cy - size * 0.2,
    size * 0.06,
    cx,
    cy,
    size * 0.55,
  );
  metal.addColorStop(0, '#6b7581');
  metal.addColorStop(0.55, '#343c47');
  metal.addColorStop(1, '#151a21');

  ctx.fillStyle = metal;
  ctx.strokeStyle = 'rgba(9,13,18,0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let first = true;
  for (let i = 0; i < teeth; i++) {
    const angle = i * step - Math.PI / 2;
    const points = [
      polar(cx, cy, outer, angle - step * 0.24),
      polar(cx, cy, outer, angle + step * 0.24),
      polar(cx, cy, root, angle + step * 0.33),
      polar(cx, cy, root, angle + step * 0.5),
    ];
    for (const point of points) {
      if (first) {
        ctx.moveTo(point.x, point.y);
        first = false;
      } else {
        ctx.lineTo(point.x, point.y);
      }
    }
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Hub bore and inner rim.
  const hub = size * 0.17;
  ctx.beginPath();
  ctx.arc(cx, cy, hub, 0, Math.PI * 2);
  ctx.fillStyle = '#0f141a';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Highlight arc across the upper rim.
  ctx.beginPath();
  ctx.arc(cx, cy, root * 0.9, Math.PI * 1.05, Math.PI * 1.55);
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = size * 0.05;
  ctx.stroke();
}

function drawWasher(ctx: CanvasRenderingContext2D, box: SampleBox): void {
  const size = Math.min(box.width, box.height);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const outer = size / 2 - 1;
  const hole = size * 0.32;

  const metal = ctx.createRadialGradient(
    cx - size * 0.2,
    cy - size * 0.24,
    size * 0.06,
    cx,
    cy,
    size * 0.58,
  );
  metal.addColorStop(0, '#ffffff');
  metal.addColorStop(0.5, '#d9e0e9');
  metal.addColorStop(1, '#8b95a5');

  ctx.fillStyle = metal;
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, hole, 0, Math.PI * 2);
  ctx.fillStyle = '#1a202a';
  ctx.fill();
  ctx.strokeStyle = 'rgba(15,23,42,0.65)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Mirror-like highlight on the ring.
  ctx.beginPath();
  ctx.arc(cx, cy, (outer + hole) / 2, Math.PI * 1.12, Math.PI * 1.62);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = size * 0.055;
  ctx.stroke();
}

function drawObject(ctx: CanvasRenderingContext2D, className: SampleClass, box: SampleBox): void {
  switch (className) {
    case 'bolt':
      drawBolt(ctx, box);
      break;
    case 'gear':
      drawGear(ctx, box);
      break;
    case 'washer':
      drawWasher(ctx, box);
      break;
  }
}

function renderScene(index: number, random: () => number): SampleScene {
  const { canvas, ctx } = createCanvas();
  drawBackground(ctx, random);

  const objectCount = 1 + Math.floor(random() * 3);
  const labels: SampleScene['labels'] = [];
  const placed: SampleBox[] = [];
  for (let slot = 0; slot < objectCount; slot++) {
    const className =
      SAMPLE_CLASSES[
        (index + slot + Math.floor(random() * SAMPLE_CLASSES.length)) % SAMPLE_CLASSES.length
      ];
    const box = placeObject(className, placed, random);
    drawObject(ctx, className, box);
    placed.push(box);
    labels.push({ className, box: { ...box } });
  }

  let pngDataUrl: string;
  try {
    pngDataUrl = canvas.toDataURL('image/png');
  } catch {
    throw new Error('Failed to encode a sample scene as PNG.');
  }

  return {
    name: `sample-${String(index + 1).padStart(2, '0')}.png`,
    width: SCENE_WIDTH,
    height: SCENE_HEIGHT,
    pngDataUrl,
    labels,
  };
}

/**
 * Generate a deterministic demo dataset.
 *
 * Each scene is 480x360, has a textured dark workbench background, and
 * contains one to three non-overlapping bolts, gears, or washers. Label boxes
 * are in source-image pixels and match the painted objects.
 *
 * @param count Number of scenes to generate; values are floored.
 * @param seed PRNG seed; the same seed always produces the same scenes.
 * @throws When called without a canvas-capable browser environment.
 */
export async function generateSampleScenes(count: number, seed = 1337): Promise<SampleScene[]> {
  if (!Number.isFinite(count) || count < 0) {
    throw new Error('generateSampleScenes requires a non-negative finite count.');
  }
  const random = mulberry32(Number.isFinite(seed) ? seed : 1337);
  const scenes: SampleScene[] = [];
  for (let index = 0; index < Math.floor(count); index++) {
    scenes.push(renderScene(index, random));
  }
  return scenes;
}
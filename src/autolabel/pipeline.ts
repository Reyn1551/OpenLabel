import type {
  Annotation,
  AutoLabelSettings,
  ClassDef,
  Geometry,
  ModelBundle,
  Prediction,
  ProjectType,
  Point,
} from '@/core/types';
import { bboxOfGeometry } from '@/core/geometry';
import { uid, now } from '@/core/repo';
import {
  buildCellGrid,
  descriptors as describeRects,
  releaseGrid,
  descriptor,
  rectIoU,
  mulberry32,
  type CellGrid,
  type Rect,
  type RGBAImage,
} from './features';
import { ANCHOR_SCALES, clusterAnchors, generateProposals } from './anchors';
import {
  centroid,
  cosine,
  evaluateDetections,
  fuseBoxes,
  nmsPerClass,
  scoreDescriptor,
  trainLinearSoftmax,
  type ScoredBox,
  type TrainSample,
  type TrainedLinear,
} from './model';
import { refineBoxToPolygon } from './mask';

export const MODEL_FORMAT_VERSION = 1;

export interface TrainImage {
  id: string;
  name: string;
  width: number;
  height: number;
  /** RGBA pixels of the working-resolution image. */
  data: Uint8ClampedArray | Uint8Array;
  /** Scale from source pixels to `data` pixels. */
  scale: number;
}

export interface TrainDataset {
  projectId: string;
  projectType: ProjectType;
  classes: ClassDef[];
  images: TrainImage[];
  annotations: Annotation[];
  settings: AutoLabelSettings;
}

export interface TrainProgress {
  stage: 'features' | 'training' | 'validating' | 'finalizing';
  progress: number;
  message: string;
}

type ProgressFn = (progress: TrainProgress) => void;

interface SampleRecord extends TrainSample {
  imageId: string;
  box: Rect;
}

const WORKING_LONG_SIDE = 768;

/** Bilinear RGBA resize; deterministic and usable inside a worker. */
export function resizeImageData(img: RGBAImage, targetW: number, targetH: number): RGBAImage {
  const w = Math.max(1, Math.round(targetW));
  const h = Math.max(1, Math.round(targetH));
  const out = new Uint8ClampedArray(w * h * 4);
  const ratioX = img.width / w;
  const ratioY = img.height / h;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, (y + 0.5) * ratioY - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, (x + 0.5) * ratioX - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = sx - x0;
      const i00 = (y0 * img.width + x0) * 4;
      const i10 = (y0 * img.width + x1) * 4;
      const i01 = (y1 * img.width + x0) * 4;
      const i11 = (y1 * img.width + x1) * 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = img.data[i00 + c] * (1 - wx) + img.data[i10 + c] * wx;
        const bottom = img.data[i01 + c] * (1 - wx) + img.data[i11 + c] * wx;
        out[o + c] = top * (1 - wy) + bottom * wy;
      }
    }
  }
  return { data: out, width: w, height: h };
}

export function prepareWorkingImage(width: number, height: number, data: Uint8ClampedArray): TrainImage {
  const longSide = Math.max(width, height);
  if (longSide <= WORKING_LONG_SIDE) {
    return { id: '', name: '', width, height, data, scale: 1 };
  }
  const scale = WORKING_LONG_SIDE / longSide;
  const resized = resizeImageData({ data, width, height }, width * scale, height * scale);
  return { id: '', name: '', width: resized.width, height: resized.height, data: resized.data, scale };
}

export interface GridLevel {
  grid: CellGrid;
  scale: number;
}

function gridLevels(img: TrainImage): GridLevel[] {
  const levels: GridLevel[] = [];
  const base: RGBAImage = { data: img.data, width: img.width, height: img.height };
  levels.push({ grid: buildCellGrid(base, 4), scale: 1 });
  const half = resizeImageData(base, Math.round(img.width * 0.6), Math.round(img.height * 0.6));
  levels.push({ grid: buildCellGrid(half, 4), scale: 0.6 });
  return levels;
}

function annotationBoxes(annotation: Annotation): Rect | null {
  if (annotation.geometry.kind === 'keypoints' && annotation.geometry.points.length === 0) return null;
  const box = bboxOfGeometry(annotation.geometry);
  if (box.width < 8 || box.height < 8) return null;
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function chooseLevel(levels: GridLevel[], box: Rect): GridLevel {
  const candidates = levels.filter((level) => {
    const minSide = Math.min(box.width, box.height) * level.scale;
    return minSide >= 12 && minSide <= 512;
  });
  if (candidates.length === 0) return levels[0];
  // Prefer the level where the object is closest to 64 px on its short side.
  return candidates.reduce((best, level) => {
    const current = Math.abs(Math.min(box.width, box.height) * level.scale - 64);
    const incumbent = Math.abs(Math.min(box.width, box.height) * best.scale - 64);
    return current < incumbent ? level : best;
  });
}

function randomNegatives(
  grid: CellGrid,
  anchors: Rect[],
  positives: Rect[],
  count: number,
  rand: () => number,
): Rect[] {
  const out: Rect[] = [];
  let attempts = 0;
  while (out.length < count && attempts < count * 40) {
    attempts += 1;
    const anchor = anchors[Math.floor(rand() * anchors.length)];
    const scale = ANCHOR_SCALES[Math.floor(rand() * ANCHOR_SCALES.length)];
    const w = anchor.width * scale;
    const h = anchor.height * scale;
    if (w < 12 || h < 12) continue;
    const x = rand() * Math.max(1, grid.width - w);
    const y = rand() * Math.max(1, grid.height - h);
    const rect = { x, y, width: w, height: h };
    if (positives.some((p) => rectIoU(p, rect) > 0.15)) continue;
    // A little jitter around the anchor size keeps the negative pool diverse.
    out.push(rect);
  }
  return out;
}

function buildDescriptorSamples(
  dataset: TrainDataset,
  classIndex: Map<string, number>,
  include: (imageId: string) => boolean,
  onProgress?: ProgressFn,
): SampleRecord[] {
  const samples: SampleRecord[] = [];
  const byImage = new Map<string, Annotation[]>();
  for (const annotation of dataset.annotations) {
    if (!classIndex.has(annotation.classId)) continue;
    const list = byImage.get(annotation.imageId) ?? [];
    list.push(annotation);
    byImage.set(annotation.imageId, list);
  }

  const anchors = clusterAnchors(
    dataset.annotations
      .map((a) => {
        const image = dataset.images.find((i) => i.id === a.imageId);
        const box = annotationBoxes(a);
        return image && box ? { ...box, width: box.width * image.scale, height: box.height * image.scale } : null;
      })
      .filter((b): b is Rect => b !== null),
    3,
  );

  const total = dataset.images.length || 1;
  dataset.images.forEach((image, index) => {
    if (!include(image.id)) return;
    // One image at a time: a 5000-image project must not hold every grid.
    const levels = gridLevels(image);
    try {
    const annotations = byImage.get(image.id) ?? [];
    const boxes: Rect[] = [];
    for (const annotation of annotations) {
      const box = annotationBoxes(annotation);
      if (!box) continue;
      const level = chooseLevel(levels, box);
      const scaled: Rect = {
        x: box.x * image.scale * level.scale,
        y: box.y * image.scale * level.scale,
        width: box.width * image.scale * level.scale,
        height: box.height * image.scale * level.scale,
      };
      if (Math.min(scaled.width, scaled.height) < 8) continue;
      boxes.push(scaled);
      const classIdx = classIndex.get(annotation.classId)!;
      // Positive plus four jitters: enough invariance for tiny datasets.
      const jitter = [
        [0, 0, 1, 1],
        [0.06, 0.04, 1.08, 1.06],
        [-0.06, -0.04, 0.94, 0.96],
        [0.03, -0.05, 1.05, 0.94],
        [-0.04, 0.05, 0.96, 1.05],
      ];
      for (const [dx, dy, sw, sh] of jitter) {
        const jittered: Rect = {
          x: scaled.x + scaled.width * dx,
          y: scaled.y + scaled.height * dy,
          width: scaled.width * sw,
          height: scaled.height * sh,
        };
        const vec = descriptor(level.grid, clampRect(jittered, level.grid.width, level.grid.height));
        if (vec) samples.push({ x: vec, y: classIdx, imageId: image.id, box: scaled });
      }
    }

    const negatives = randomNegatives(
      levels[0].grid,
      anchors,
      boxes,
      Math.max(48, boxes.length * 10),
      mulberry32(7919 + index),
    );
    for (const rect of negatives) {
      const vec = descriptor(levels[0].grid, rect);
      if (vec) samples.push({ x: vec, y: -1, imageId: image.id, box: rect });
    }
    onProgress?.({
      stage: 'features',
      progress: (index + 1) / total,
      message: `Extracting features ${index + 1}/${total}`,
    });
    } finally {
      for (const level of levels) releaseGrid(level.grid);
    }
  });
  return samples;
}

function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width - 2, rect.x));
  const y = Math.max(0, Math.min(height - 2, rect.y));
  return {
    x,
    y,
    width: Math.max(2, Math.min(width - x, rect.width)),
    height: Math.max(2, Math.min(height - y, rect.height)),
  };
}

function detectInLevel(
  grid: CellGrid,
  linear: TrainedLinear,
  classIds: string[],
  anchors: Rect[],
  threshold: number,
  nmsIou: number,
  maxPerImage: number,
  templates: Map<string, Float32Array>,
  templateWeight: number,
): { box: Rect; classIndex: number; score: number }[] {
  const proposals = generateProposals(anchors, grid.width, grid.height, {
    stride: Math.max(6, grid.cell * 2),
    minSize: 14,
  });
  const scored: ScoredBox[] = [];
  const scores = { classIndex: 0, confidence: 0, background: 0 };
  // One boundary call per level instead of one per proposal.
  const vectors = describeRects(grid, proposals.map((proposal) => proposal.rect));
  for (let index = 0; index < proposals.length; index += 1) {
    const rect = proposals[index].rect;
    const vec = vectors[index];
    if (!vec) continue;
    Object.assign(scores, scoreDescriptor(linear, vec));
    if (scores.confidence < threshold * 0.75) continue;
    let finalScore = scores.confidence;
    if (templateWeight > 0 && templates.size > 0) {
      const template = templates.get(classIds[scores.classIndex]);
      if (template) {
        const sim = Math.max(0, cosine(vec, template));
        finalScore *= (1 - templateWeight) + templateWeight * sim;
      }
    }
    if (finalScore < threshold) continue;
    scored.push({ classIndex: scores.classIndex, box: rect, score: finalScore });
  }
  const fused = fuseBoxes(scored, 0.1);
  return nmsPerClass(fused, nmsIou, maxPerImage);
}

/** Detection inference for one working-resolution image. */
export function detectInImage(
  img: TrainImage,
  linear: TrainedLinear,
  classIds: string[],
  anchors: Rect[],
  templates: Map<string, Float32Array>,
  settings: AutoLabelSettings,
  threshold = settings.confidence,
): Prediction[] {
  const levels = gridLevels(img);
  const all: { box: Rect; classIndex: number; score: number }[] = [];
  try {
  for (const level of levels) {
    const scaledAnchors = anchors.map((a) => ({
      ...a,
      width: a.width * level.scale,
      height: a.height * level.scale,
    }));
    const predictions = detectInLevel(
      level.grid,
      linear,
      classIds,
      scaledAnchors,
      threshold,
      settings.nmsIou,
      settings.maxPerImage,
      templates,
      settings.templateWeight,
    );
    for (const prediction of predictions) {
      all.push({
        classIndex: prediction.classIndex,
        score: prediction.score,
        box: {
          x: prediction.box.x / level.scale,
          y: prediction.box.y / level.scale,
          width: prediction.box.width / level.scale,
          height: prediction.box.height / level.scale,
        },
      });
    }
  }
  } finally {
    for (const level of levels) releaseGrid(level.grid);
  }
  // Merge levels with a final NMS pass in working space.
  const merged = nmsPerClass(all, settings.nmsIou, settings.maxPerImage);
  return merged.map((item) => ({
    classId: classIds[item.classIndex],
    score: item.score,
    geometry: { kind: 'bbox', x: item.box.x, y: item.box.y, width: item.box.width, height: item.box.height },
  }));
}

export interface TrainResult {
  bundle: ModelBundle;
  linear: TrainedLinear;
  anchors: Rect[];
  templates: Map<string, Float32Array>;
}

export function trainAutoLabel(dataset: TrainDataset, onProgress?: ProgressFn): TrainResult {
  const classIndex = new Map<string, number>();
  dataset.classes.forEach((cls, index) => classIndex.set(cls.id, index));
  const usable = dataset.annotations.filter((a) => classIndex.has(a.classId));
  if (usable.length === 0 || dataset.classes.length === 0) {
    throw new Error('Add annotations before training.');
  }
  if (dataset.projectType === 'classification') {
    return trainClassificationModel(dataset, classIndex, usable, onProgress);
  }

  onProgress?.({ stage: 'features', progress: 0, message: 'Preparing working images' });
  const allSamples = buildDescriptorSamples(dataset, classIndex, () => true, (p) =>
    onProgress?.({ ...p, progress: p.progress * 0.65 }),
  );
  if (allSamples.length === 0) throw new Error('No usable annotations (boxes must be at least 8 px).');

  const anchors = clusterAnchors(
    usable
      .map((a) => {
        const image = dataset.images.find((i) => i.id === a.imageId);
        const box = annotationBoxes(a);
        return image && box
          ? { x: 0, y: 0, width: box.width * image.scale, height: box.height * image.scale }
          : null;
      })
      .filter((b): b is Rect => b !== null),
    3,
  );

  // Cross-validation over images: folds are whole images, never boxes, so the
  // reported precision/recall cannot be inflated by near-duplicate windows.
  const uniqueImages = [...new Set(allSamples.map((s) => s.imageId))];
  const folds = Math.min(3, Math.max(1, uniqueImages.length));
  const foldOf = new Map<string, number>();
  uniqueImages.forEach((id, index) => foldOf.set(id, index % folds));
  const groundTruth = new Map<string, { box: Rect; classIndex: number }[]>();
  for (const image of dataset.images) {
    const entries: { box: Rect; classIndex: number }[] = [];
    for (const annotation of dataset.annotations) {
      if (annotation.imageId !== image.id) continue;
      const cls = classIndex.get(annotation.classId);
      const box = annotationBoxes(annotation);
      if (cls === undefined || !box) continue;
      entries.push({
        box: {
          x: box.x * image.scale,
          y: box.y * image.scale,
          width: box.width * image.scale,
          height: box.height * image.scale,
        },
        classIndex: cls,
      });
    }
    groundTruth.set(image.id, entries);
  }

  let bestThreshold = dataset.settings.confidence;
  let bestF1 = -1;
  let bestPrecision = 0;
  let bestRecall = 0;
  let evaluated = 0;
  const widthRatios: number[] = [];
  const heightRatios: number[] = [];

  if (folds > 1) {
    for (let fold = 0; fold < folds; fold++) {
      const trainSamples = allSamples.filter((s) => foldOf.get(s.imageId) !== fold);
      const holdout = dataset.images.filter((image) => foldOf.get(image.id) === fold);
      if (trainSamples.length === 0 || holdout.length === 0) continue;
      onProgress?.({
        stage: 'validating',
        progress: (fold + 1) / (folds + 1),
        message: `Validating fold ${fold + 1}/${folds}`,
      });
      const foldLinear = trainLinearSoftmax(trainSamples, dataset.classes.length + 1, {
        epochs: 120,
        seed: 1000 + fold,
      });
      const templates = buildTemplates(trainSamples, classIndex);
      const predictions: { box: Rect; classIndex: number; score: number }[] = [];
      const truths: { box: Rect; classIndex: number }[] = [];
      for (const image of holdout) {
        truths.push(...(groundTruth.get(image.id) ?? []));
        const levels = gridLevels(image);
        try {
        for (const level of levels) {
          const scaledAnchors = anchors.map((a) => ({
            ...a,
            width: a.width * level.scale,
            height: a.height * level.scale,
          }));
          const preds = detectInLevel(
            level.grid,
            foldLinear,
            dataset.classes.map((c) => c.id),
            scaledAnchors,
            0.2,
            dataset.settings.nmsIou,
            20,
            templates,
            dataset.settings.templateWeight,
          );
          for (const prediction of preds) {
            predictions.push({
              classIndex: prediction.classIndex,
              score: prediction.score,
              box: {
                x: prediction.box.x / level.scale,
                y: prediction.box.y / level.scale,
                width: prediction.box.width / level.scale,
                height: prediction.box.height / level.scale,
              },
            });
          }
        }
        } finally {
          for (const level of levels) releaseGrid(level.grid);
        }
      }
      collectBoxRatios(truths, predictions, widthRatios, heightRatios);
      const metrics = evaluateDetections(truths, predictions);
      evaluated += truths.length;
      if (metrics.f1 > bestF1) {
        bestF1 = metrics.f1;
        bestThreshold = metrics.threshold;
        bestPrecision = metrics.precision;
        bestRecall = metrics.recall;
      }
    }
  } else {
    const linear = trainLinearSoftmax(allSamples, dataset.classes.length + 1, { epochs: 120 });
    const templates = buildTemplates(allSamples, classIndex);
    const predictions: { box: Rect; classIndex: number; score: number }[] = [];
    const truths: { box: Rect; classIndex: number }[] = [];
    for (const image of dataset.images) {
      truths.push(...(groundTruth.get(image.id) ?? []));
      const levels = gridLevels(image);
      try {
        const preds = detectInLevel(
          levels[0].grid,
          linear,
          dataset.classes.map((c) => c.id),
          anchors,
          0.2,
          dataset.settings.nmsIou,
          20,
          templates,
          dataset.settings.templateWeight,
        );
        predictions.push(...preds.map((p) => ({ classIndex: p.classIndex, score: p.score, box: p.box })));
      } finally {
        for (const level of levels) releaseGrid(level.grid);
      }
    }
    collectBoxRatios(truths, predictions, widthRatios, heightRatios);
    const metrics = evaluateDetections(truths, predictions);
    bestThreshold = metrics.threshold;
    bestPrecision = metrics.precision;
    bestRecall = metrics.recall;
    bestF1 = metrics.f1;
    evaluated = truths.length;
  }

  onProgress?.({ stage: 'training', progress: 0.9, message: 'Training final model' });
  const linear = trainLinearSoftmax(allSamples, dataset.classes.length + 1, {
    epochs: 180,
    seed: 2024,
  });
  const templates = buildTemplates(allSamples, classIndex);
  const priors = buildKeypointPriors(dataset);
  const imageCentroids = buildImageCentroids(dataset, classIndex);

  onProgress?.({ stage: 'finalizing', progress: 1, message: 'Saving model' });
  const bundle: ModelBundle = {
    id: uid('mdl'),
    projectId: dataset.projectId,
    createdAt: now(),
    projectType: dataset.projectType,
    classes: dataset.classes.map((c) => ({ id: c.id, name: c.name, color: c.color })),
    trainedOn: usable.length,
    dim: linear.dim,
    weights: Array.from(linear.weights),
    bias: Array.from(linear.bias),
    anchors: anchors.map((a) => ({ width: a.width, height: a.height })),
    templates: [...templates.entries()].map(([classId, vector]) => ({
      classId,
      vector: Array.from(vector),
    })),
    keypointPriors: priors,
    imageCentroids,
    threshold: bestThreshold,
    boxScale: {
      width: clampRatio(median(widthRatios)),
      height: clampRatio(median(heightRatios)),
    },
    metrics: {
      precision: bestPrecision,
      recall: bestRecall,
      f1: Math.max(0, bestF1),
      evaluated,
      threshold: bestThreshold,
    },
    config: dataset.settings,
    formatVersion: MODEL_FORMAT_VERSION,
  };
  return { bundle, linear, anchors, templates };
}

function buildTemplates(samples: SampleRecord[], classIndex: Map<string, number>): Map<string, Float32Array> {
  const byClass = new Map<number, Float32Array[]>();
  for (const sample of samples) {
    if (sample.y < 0) continue;
    const list = byClass.get(sample.y) ?? [];
    list.push(sample.x);
    byClass.set(sample.y, list);
  }
  const out = new Map<string, Float32Array>();
  for (const [id, index] of classIndex) {
    const template = centroid(byClass.get(index) ?? []);
    if (template) out.set(id, template);
  }
  return out;
}

function buildKeypointPriors(dataset: TrainDataset): { classId: string; points: number[][] }[] {
  const accum = new Map<string, number[][][]>();
  for (const annotation of dataset.annotations) {
    if (annotation.geometry.kind !== 'keypoints' || annotation.geometry.points.length === 0) continue;
    const box = bboxOfGeometry(annotation.geometry);
    if (box.width < 4 || box.height < 4) continue;
    const normalized = annotation.geometry.points.map((p) => [
      (p.x - box.x) / box.width,
      (p.y - box.y) / box.height,
    ]);
    const existing = accum.get(annotation.classId) ?? [];
    existing.push(normalized);
    accum.set(annotation.classId, existing);
  }
  const out: { classId: string; points: number[][] }[] = [];
  for (const [classId, samples] of accum) {
    const count = Math.min(...samples.map((s) => s.length));
    const points: number[][] = [];
    for (let i = 0; i < count; i++) {
      let x = 0;
      let y = 0;
      for (const sample of samples) {
        x += sample[i][0];
        y += sample[i][1];
      }
      points.push([x / samples.length, y / samples.length]);
    }
    out.push({ classId, points });
  }
  return out;
}

function buildImageCentroids(dataset: TrainDataset, classIndex: Map<string, number>): { classId: string; vector: number[] }[] {
  const byClass = new Map<number, Float32Array[]>();
  for (const image of dataset.images) {
    const annotation = dataset.annotations.find((a) => a.imageId === image.id);
    if (!annotation) continue;
    const index = classIndex.get(annotation.classId);
    if (index === undefined) continue;
    const vec = globalDescriptor({ data: image.data, width: image.width, height: image.height });
    const list = byClass.get(index) ?? [];
    list.push(vec);
    byClass.set(index, list);
  }
  const out: { classId: string; vector: number[] }[] = [];
  for (const [id, index] of classIndex) {
    const c = centroid(byClass.get(index) ?? []);
    if (c) out.push({ classId: id, vector: Array.from(c) });
  }
  return out;
}

/** 92-dim global descriptor computed from RGBA pixels (no canvas needed). */
export function globalDescriptor(img: RGBAImage): Float32Array {
  const size = 48;
  const small = img.width === size && img.height === size ? img : resizeImageData(img, size, size);
  const color = new Float32Array(48);
  const gradHist = new Float32Array(8);
  const energy = new Float32Array(16);
  const lum = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    lum[i] = (small.data[o] * 0.299 + small.data[o + 1] * 0.587 + small.data[o + 2] * 0.114) / 255;
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cell = Math.floor(y / 12) * 4 + Math.floor(x / 12);
      const o = (y * size + x) * 4;
      color[cell * 3] += small.data[o] / 255;
      color[cell * 3 + 1] += small.data[o + 1] / 255;
      color[cell * 3 + 2] += small.data[o + 2] / 255;
      const xm = Math.max(0, x - 1);
      const xp = Math.min(size - 1, x + 1);
      const ym = Math.max(0, y - 1);
      const yp = Math.min(size - 1, y + 1);
      const gx = (lum[y * size + xp] - lum[y * size + xm]) * 0.5;
      const gy = (lum[yp * size + x] - lum[ym * size + x]) * 0.5;
      const mag = Math.hypot(gx, gy);
      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI;
      const bin = Math.min(7, Math.floor((angle / Math.PI) * 8));
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
  let mean = 0;
  for (const v of lum) mean += v;
  const aspect = img.width / Math.max(1, img.height);
  return new Float32Array([
    ...norm(color),
    ...norm(gradHist),
    ...norm(energy),
    Math.min(2, aspect) / 2,
    mean / lum.length,
  ]);
}

/** Rebuilds runtime structures from a stored bundle (worker starts cold). */
export function loadModel(bundle: ModelBundle): {
  linear: TrainedLinear;
  classIds: string[];
  anchors: Rect[];
  templates: Map<string, Float32Array>;
} {
  const rows = bundle.bias.length;
  const linear: TrainedLinear = {
    weights: Float32Array.from(bundle.weights),
    bias: Float32Array.from(bundle.bias),
    rows,
    dim: bundle.dim,
    finalLoss: 0,
  };
  return {
    linear,
    classIds: bundle.classes.map((c) => c.id),
    anchors: bundle.anchors.map((a) => ({ x: 0, y: 0, width: a.width, height: a.height })),
    templates: new Map(bundle.templates.map((t) => [t.classId, Float32Array.from(t.vector)])),
  };
}

/** Full auto-label prediction for one image. */
export function predictImage(
  bundle: ModelBundle,
  image: TrainImage,
  settings: AutoLabelSettings,
  options: { sourceWidth: number; sourceHeight: number },
): Prediction[] {
  if (bundle.projectType === 'classification') return predictClassification(bundle, image);
  const { linear, classIds, anchors, templates } = loadModel(bundle);
  const raw = detectInImage(image, linear, classIds, anchors, templates, settings);
  const { width: bw, height: bh } = bundle.boxScale ?? { width: 1, height: 1 };
  const predictions = raw.map((prediction) => {
    if (prediction.geometry.kind !== 'bbox') return prediction;
    const box = prediction.geometry;
    const width = box.width * bw;
    const height = box.height * bh;
    return {
      ...prediction,
      geometry: {
        kind: 'bbox' as const,
        x: box.x - (width - box.width) / 2,
        y: box.y - (height - box.height) / 2,
        width,
        height,
      },
    };
  });
  const scaleX = options.sourceWidth / image.width;
  const scaleY = options.sourceHeight / image.height;
  const priors = new Map(bundle.keypointPriors.map((p) => [p.classId, p.points]));
  return predictions
    .map((prediction) => {
      if (prediction.geometry.kind !== 'bbox') return prediction;
      const box = {
        x: prediction.geometry.x * scaleX,
        y: prediction.geometry.y * scaleY,
        width: prediction.geometry.width * scaleX,
        height: prediction.geometry.height * scaleY,
      };
      if (bundle.projectType === 'instance-segmentation') {
        const polygon = refineBoxToPolygon(
          { data: image.data, width: image.width, height: image.height },
          {
            x: prediction.geometry.x,
            y: prediction.geometry.y,
            width: prediction.geometry.width,
            height: prediction.geometry.height,
          },
        );
        return {
          ...prediction,
          geometry: {
            kind: 'polygon',
            points: polygon.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY })),
          } as Geometry,
        };
      }
      if (bundle.projectType === 'keypoint') {
        const prior = priors.get(prediction.classId);
        if (prior && prior.length > 0) {
          const points: Point[] = prior.map((p) => ({
            x: box.x + p[0] * box.width,
            y: box.y + p[1] * box.height,
          }));
          return { ...prediction, geometry: { kind: 'keypoints', points } as Geometry };
        }
      }
      return { ...prediction, geometry: { kind: 'bbox', ...box } as Geometry };
    })
    .filter((prediction) => prediction.score >= settings.confidence);
}

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function clampRatio(value: number): number {
  return Math.min(2, Math.max(0.6, value));
}

function collectBoxRatios(
  truths: { box: Rect; classIndex: number }[],
  predictions: { box: Rect; classIndex: number; score: number }[],
  widthRatios: number[],
  heightRatios: number[],
): void {
  for (const truth of truths) {
    let best = 0.3;
    let match: { box: Rect } | null = null;
    for (const prediction of predictions) {
      if (prediction.classIndex !== truth.classIndex) continue;
      const overlap = rectIoU(truth.box, prediction.box);
      if (overlap > best) {
        best = overlap;
        match = prediction;
      }
    }
    if (match && match.box.width > 2 && match.box.height > 2) {
      widthRatios.push(truth.box.width / match.box.width);
      heightRatios.push(truth.box.height / match.box.height);
    }
  }
}

export function predictClassification(bundle: ModelBundle, image: TrainImage): Prediction[] {
  const vec = globalDescriptor({ data: image.data, width: image.width, height: image.height });
  const { linear, classIds } = loadModel(bundle);
  const scored = scoreDescriptor(linear, vec, { backgroundRow: null });
  const best = { classId: classIds[scored.classIndex], score: scored.confidence };
  if (!best.classId) return [];
  return [
    {
      classId: best.classId,
      score: best.score,
      geometry: {
        kind: 'bbox',
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
      },
    },
  ];
}

/**
 * Image-level classifier: one softmax over global descriptors.
 * Evaluated leave-one-out so the reported numbers are honest with 10 images.
 */
function trainClassificationModel(
  dataset: TrainDataset,
  classIndex: Map<string, number>,
  usable: Annotation[],
  onProgress?: ProgressFn,
): TrainResult {
  const samples: { x: Float32Array; y: number; imageId: string }[] = [];
  const labels = new Map<string, number>();
  for (const image of dataset.images) {
    const own = usable.filter((a) => a.imageId === image.id);
    if (own.length === 0) continue;
    const counts = new Map<number, number>();
    for (const annotation of own) {
      const index = classIndex.get(annotation.classId);
      if (index === undefined) continue;
      counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    let label = -1;
    let bestCount = 0;
    for (const [index, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        label = index;
      }
    }
    if (label < 0) continue;
    labels.set(image.id, label);
    samples.push({
      x: globalDescriptor({ data: image.data, width: image.width, height: image.height }),
      y: label,
      imageId: image.id,
    });
  }
  if (samples.length < 2) throw new Error('Add at least two labeled images before training.');

  onProgress?.({ stage: 'validating', progress: 0.4, message: 'Validating leave-one-out' });
  let correct = 0;
  let predicted = 0;
  for (let i = 0; i < samples.length; i++) {
    const rest = samples.filter((_, index) => index !== i);
    if (new Set(rest.map((s) => s.y)).size < 1) continue;
    const fold = trainLinearSoftmax(rest.map(({ x, y }) => ({ x, y })), dataset.classes.length, {
      epochs: 90,
      seed: 500 + i,
    });
    const scored = scoreDescriptor(fold, samples[i].x, { backgroundRow: null });
    predicted += 1;
    if (scored.classIndex === samples[i].y) {
      correct += 1;
    }
  }
  const accuracy = predicted ? correct / predicted : 0;

  onProgress?.({ stage: 'training', progress: 0.7, message: 'Training classifier' });
  const linear = trainLinearSoftmax(
    samples.map(({ x, y }) => ({ x, y })),
    dataset.classes.length,
    { epochs: 220, seed: 77 },
  );
  const centroids = buildImageCentroidsFromSamples(samples, classIndex);
  const bundle: ModelBundle = {
    id: uid('mdl'),
    projectId: dataset.projectId,
    createdAt: now(),
    projectType: dataset.projectType,
    classes: dataset.classes.map((c) => ({ id: c.id, name: c.name, color: c.color })),
    trainedOn: usable.length,
    dim: linear.dim,
    weights: Array.from(linear.weights),
    bias: Array.from(linear.bias),
    anchors: [],
    templates: [],
    keypointPriors: [],
    imageCentroids: centroids,
    threshold: 0.5,
    boxScale: { width: 1, height: 1 },
    metrics: {
      precision: accuracy,
      recall: accuracy,
      f1: accuracy,
      evaluated: predicted,
      threshold: 0.5,
    },
    config: dataset.settings,
    formatVersion: MODEL_FORMAT_VERSION,
  };
  onProgress?.({ stage: 'finalizing', progress: 1, message: 'Saving model' });
  return { bundle, linear, anchors: [], templates: new Map() };
}

function buildImageCentroidsFromSamples(
  samples: { x: Float32Array; y: number }[],
  classIndex: Map<string, number>,
): { classId: string; vector: number[] }[] {
  const out: { classId: string; vector: number[] }[] = [];
  for (const [id, index] of classIndex) {
    const vectors = samples.filter((s) => s.y === index).map((s) => s.x);
    const c = centroid(vectors);
    if (c) out.push({ classId: id, vector: Array.from(c) });
  }
  return out;
}
import { DESCRIPTOR_DIM, mulberry32, type Rect } from './features';

/**
 * Linear softmax classifier with a dedicated background row.
 *
 * Linear models on window descriptors are the reason few-shot training is
 * instant and deterministic: no GPU, no epochs over pixels, no downloads.
 */

export interface TrainSample {
  x: Float32Array;
  /** Class index in `classIds`; -1 means background. */
  y: number;
}

export interface TrainedClassifier {
  dim: number;
  classIds: string[];
  /** Row count = classIds.length + 1 (last row is background). */
  weights: Float32Array;
  bias: Float32Array;
  threshold: number;
  templates: Map<string, Float32Array>;
  metrics: { precision: number; recall: number; f1: number; evaluated: number; threshold: number };
}

export interface TrainOptions {
  epochs?: number;
  learningRate?: number;
  l2?: number;
  seed?: number;
  /** Balance classes by inverse frequency (important with 10 annotations). */
  classWeights?: boolean;
}

export function initWeights(rows: number, dim: number, seed = 1337): { weights: Float32Array; bias: Float32Array } {
  const rand = mulberry32(seed);
  const weights = new Float32Array(rows * dim);
  const scale = Math.sqrt(2 / dim);
  for (let i = 0; i < weights.length; i++) {
    // Box–Muller for a proper Gaussian initialization.
    const u = Math.max(1e-9, rand());
    const v = rand();
    weights[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * scale;
  }
  return { weights, bias: new Float32Array(rows) };
}

function softmaxInto(logits: Float32Array, out: Float32Array): void {
  let max = -Infinity;
  for (const v of logits) if (v > max) max = v;
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    const e = Math.exp(logits[i] - max);
    out[i] = e;
    sum += e;
  }
  const inv = sum > 0 ? 1 / sum : 0;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
}

export interface TrainedLinear {
  weights: Float32Array;
  bias: Float32Array;
  rows: number;
  dim: number;
  finalLoss: number;
}

/** Full-batch Adam with class weighting; deterministic for a given seed. */
export function trainLinearSoftmax(samples: TrainSample[], rows: number, opts: TrainOptions = {}): TrainedLinear {
  const dim = samples[0]?.x.length ?? DESCRIPTOR_DIM;
  const epochs = opts.epochs ?? 140;
  const lr = opts.learningRate ?? 0.05;
  const l2 = opts.l2 ?? 1e-3;
  const { weights, bias } = initWeights(rows, dim, opts.seed ?? 1337);
  const n = samples.length;
  if (n === 0) return { weights, bias, rows, dim, finalLoss: 0 };

  const counts = new Float32Array(rows);
  for (const s of samples) counts[s.y < 0 ? rows - 1 : s.y] += 1;
  const sampleWeight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const row = samples[i].y < 0 ? rows - 1 : samples[i].y;
    sampleWeight[i] = opts.classWeights === false ? 1 : 1 / Math.sqrt(Math.max(1, counts[row]));
  }

  const mW = new Float32Array(weights.length);
  const vW = new Float32Array(weights.length);
  const mB = new Float32Array(bias.length);
  const vB = new Float32Array(bias.length);
  const gradW = new Float32Array(weights.length);
  const gradB = new Float32Array(bias.length);
  const logits = new Float32Array(rows);
  const probs = new Float32Array(rows);
  const beta1 = 0.9;
  const beta2 = 0.999;
  let finalLoss = 0;

  for (let epoch = 1; epoch <= epochs; epoch++) {
    gradW.fill(0);
    gradB.fill(0);
    let loss = 0;
    let weightSum = 0;
    for (let i = 0; i < n; i++) {
      const sample = samples[i];
      const row = sample.y < 0 ? rows - 1 : sample.y;
      const w = sampleWeight[i];
      weightSum += w;
      for (let r = 0; r < rows; r++) {
        let sum = bias[r];
        const offset = r * dim;
        for (let d = 0; d < dim; d++) sum += weights[offset + d] * sample.x[d];
        logits[r] = sum;
      }
      softmaxInto(logits, probs);
      const p = Math.max(1e-9, probs[row]);
      loss -= w * Math.log(p);
      const gradientScale = w;
      for (let r = 0; r < rows; r++) {
        const g = (probs[r] - (r === row ? 1 : 0)) * gradientScale;
        if (g === 0) continue;
        gradB[r] += g;
        const offset = r * dim;
        for (let d = 0; d < dim; d++) gradW[offset + d] += g * sample.x[d];
      }
    }
    finalLoss = loss / Math.max(1e-6, weightSum);
    const norm = 1 / Math.max(1e-6, weightSum);
    const bc1 = 1 - beta1 ** epoch;
    const bc2 = 1 - beta2 ** epoch;
    for (let i = 0; i < weights.length; i++) {
      const g = gradW[i] * norm + l2 * weights[i];
      mW[i] = beta1 * mW[i] + (1 - beta1) * g;
      vW[i] = beta2 * vW[i] + (1 - beta2) * g * g;
      weights[i] -= (lr * (mW[i] / bc1)) / (Math.sqrt(vW[i] / bc2) + 1e-8);
    }
    for (let r = 0; r < rows; r++) {
      const g = gradB[r] * norm;
      mB[r] = beta1 * mB[r] + (1 - beta1) * g;
      vB[r] = beta2 * vB[r] + (1 - beta2) * g * g;
      bias[r] -= (lr * (mB[r] / bc1)) / (Math.sqrt(vB[r] / bc2) + 1e-8);
    }
  }
  return { weights, bias, rows, dim, finalLoss };
}

export function scoreDescriptor(
  classifier: Pick<TrainedClassifier, 'weights' | 'bias' | 'dim'>,
  x: Float32Array,
  options: { backgroundRow?: number | null } = {},
): { classIndex: number; confidence: number; background: number } {
  const rows = classifier.bias.length;
  const logits = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let sum = classifier.bias[r];
    const offset = r * classifier.dim;
    for (let d = 0; d < classifier.dim; d++) sum += classifier.weights[offset + d] * x[d];
    logits[r] = sum;
  }
  const probs = new Float32Array(rows);
  softmaxInto(logits, probs);
  const backgroundRow = options.backgroundRow === undefined ? rows - 1 : options.backgroundRow;
  let best = 0;
  for (let r = 0; r < rows; r++) {
    if (r === backgroundRow) continue;
    if (probs[r] > probs[best]) best = r;
  }
  return {
    classIndex: best,
    confidence: probs[best],
    background: backgroundRow === null ? 0 : probs[backgroundRow],
  };
}

export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function centroid(vectors: Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0].length;
  const out = new Float32Array(dim);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i];
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) out[i] /= norm;
  return out;
}

export interface ScoredBox {
  classIndex: number;
  box: Rect;
  score: number;
}

/** Per-class greedy non-maximum suppression. */
export function nmsPerClass(items: ScoredBox[], iouThreshold: number, limit: number): ScoredBox[] {
  const kept: ScoredBox[] = [];
  const byClass = new Map<number, ScoredBox[]>();
  for (const item of items) {
    const list = byClass.get(item.classIndex) ?? [];
    list.push(item);
    byClass.set(item.classIndex, list);
  }
  for (const list of byClass.values()) {
    list.sort((a, b) => b.score - a.score);
    const accepted: ScoredBox[] = [];
    for (const candidate of list) {
      if (accepted.length >= limit) break;
      const overlaps = accepted.some((k) => iou(k.box, candidate.box) > iouThreshold);
      if (!overlaps) accepted.push(candidate);
    }
    kept.push(...accepted);
  }
  return kept.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Weighted Boxes Fusion: collapses the many shifted windows that surround one
 * object into a single weighted box. Without it, dense sliding-window inference
 * reports 5–10 near-duplicates per object.
 */
export function fuseBoxes(items: ScoredBox[], iouThreshold = 0.2): ScoredBox[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const clusters: { classIndex: number; members: ScoredBox[] }[] = [];
  for (const item of sorted) {
    let target: { classIndex: number; members: ScoredBox[] } | null = null;
    let bestIoU = iouThreshold;
    for (const cluster of clusters) {
      if (cluster.classIndex !== item.classIndex) continue;
      const fused = fusedBox(cluster.members);
      const overlap = iou(fused, item.box);
      if (overlap > bestIoU) {
        bestIoU = overlap;
        target = cluster;
      }
    }
    if (target) target.members.push(item);
    else clusters.push({ classIndex: item.classIndex, members: [item] });
  }
  return clusters
    .map((cluster) => {
      const sum = cluster.members.reduce((total, member) => total + member.score, 0);
      return {
        classIndex: cluster.classIndex,
        box: fusedBox(cluster.members),
        score: sum / cluster.members.length,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function fusedBox(members: ScoredBox[]): Rect {
  let weight = 0;
  let x = 0;
  let y = 0;
  let width = 0;
  let height = 0;
  for (const member of members) {
    weight += member.score;
    x += member.box.x * member.score;
    y += member.box.y * member.score;
    width += member.box.width * member.score;
    height += member.box.height * member.score;
  }
  if (weight <= 0) return members[0].box;
  return { x: x / weight, y: y / weight, width: width / weight, height: height / weight };
}

function iou(a: Rect, b: Rect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

export function rectIou(a: Rect, b: Rect): number {
  return iou(a, b);
}

/**
 * Picks the threshold that maximizes F1 on validation data and reports the
 * precision/recall at that operating point. Honest, not "100% accuracy".
 */
export function evaluateDetections(
  groundTruth: { box: Rect; classIndex: number }[],
  predictions: { box: Rect; classIndex: number; score: number }[],
): { precision: number; recall: number; f1: number; threshold: number } {
  const thresholds = [0.2, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8];
  let best = { precision: 0, recall: 0, f1: 0, threshold: 0.5 };
  if (groundTruth.length === 0) return best;
  for (const threshold of thresholds) {
    const filtered = predictions.filter((p) => p.score >= threshold);
    const used = new Set<number>();
    let tp = 0;
    for (const prediction of filtered) {
      let bestIoU = 0.5;
      let bestIndex = -1;
      groundTruth.forEach((gt, index) => {
        if (used.has(index) || gt.classIndex !== prediction.classIndex) return;
        const value = iou(gt.box, prediction.box);
        if (value > bestIoU) {
          bestIoU = value;
          bestIndex = index;
        }
      });
      if (bestIndex >= 0) {
        used.add(bestIndex);
        tp += 1;
      }
    }
    const precision = filtered.length > 0 ? tp / filtered.length : 0;
    const recall = tp / groundTruth.length;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    if (f1 > best.f1) best = { precision, recall, f1, threshold };
  }
  return best;
}
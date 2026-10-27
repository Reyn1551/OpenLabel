import type { Rect } from './features';

/** Deterministic k-means over log box sizes. */
export function clusterAnchors(boxes: Rect[], k = 3): Rect[] {
  const valid = boxes.filter((b) => b.width >= 8 && b.height >= 8);
  if (valid.length === 0) return [{ x: 0, y: 0, width: 64, height: 64 }];
  const points = valid.map((b) => [Math.log(b.width), Math.log(b.height)]);
  const clusters = Math.min(k, valid.length);
  const order = points
    .map((p, i) => ({ area: p[0] + p[1], i }))
    .sort((a, b) => a.area - b.area);
  let centers: number[][] = [];
  for (let c = 0; c < clusters; c++) {
    const pick = order[Math.floor(((c + 0.5) / clusters) * order.length)];
    centers.push([...points[pick.i]]);
  }
  for (let iter = 0; iter < 25; iter++) {
    const sums = centers.map(() => [0, 0, 0]);
    for (const p of points) {
      let best = 0;
      let bestDist = Infinity;
      centers.forEach((c, index) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = index;
        }
      });
      sums[best][0] += p[0];
      sums[best][1] += p[1];
      sums[best][2] += 1;
    }
    centers = sums.map((s, index) =>
      s[2] === 0 ? centers[index] : [s[0] / s[2], s[1] / s[2]],
    );
  }
  return centers.map((c) => ({
    x: 0,
    y: 0,
    width: Math.max(8, Math.exp(c[0])),
    height: Math.max(8, Math.exp(c[1])),
  }));
}

/** Scale multipliers that cover moderate object-size variance per anchor. */
export const ANCHOR_SCALES = [0.7, 1, 1.4] as const;

export interface ProposalOptions {
  stride?: number;
  minSize?: number;
  maxPerLevel?: number;
}

export interface AnchorProposal {
  rect: Rect;
  /** Index into the supplied anchor list; used for per-anchor calibration. */
  anchor: number;
}

export function generateProposals(
  anchors: Rect[],
  imageWidth: number,
  imageHeight: number,
  opts: ProposalOptions = {},
): AnchorProposal[] {
  const proposals: AnchorProposal[] = [];
  const cell = opts.stride ?? 8;
  const minSize = opts.minSize ?? 16;
  const limit = opts.maxPerLevel ?? 40000;
  for (let a = 0; a < anchors.length; a++) {
    for (const multiplier of ANCHOR_SCALES) {
      const w = Math.max(minSize, anchors[a].width * multiplier);
      const h = Math.max(minSize, anchors[a].height * multiplier);
      if (w > imageWidth * 1.2 || h > imageHeight * 1.2) continue;
      const strideX = Math.max(cell, Math.round(w * 0.28));
      const strideY = Math.max(cell, Math.round(h * 0.28));
      for (let y = 0; y + h * 0.35 <= imageHeight; y += strideY) {
        for (let x = 0; x + w * 0.35 <= imageWidth; x += strideX) {
          proposals.push({ rect: { x, y, width: w, height: h }, anchor: a });
          if (proposals.length >= limit) return proposals;
        }
      }
    }
  }
  return proposals;
}
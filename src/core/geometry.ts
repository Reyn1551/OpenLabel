import type { BBoxGeometry, Geometry, Point, PolygonGeometry } from './types';

export const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

export const round = (v: number, digits = 1): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

export function normalizeBox(box: { x: number; y: number; width: number; height: number }): BBoxGeometry {
  const x = box.width < 0 ? box.x + box.width : box.x;
  const y = box.height < 0 ? box.y + box.height : box.y;
  return {
    kind: 'bbox',
    x: Math.min(x, x + Math.abs(box.width)),
    y: Math.min(y, y + Math.abs(box.height)),
    width: Math.abs(box.width),
    height: Math.abs(box.height),
  };
}

export function boxArea(b: { width: number; height: number }): number {
  return Math.max(0, b.width) * Math.max(0, b.height);
}

export function bboxOfGeometry(geometry: Geometry): BBoxGeometry {
  switch (geometry.kind) {
    case 'bbox':
      return geometry;
    case 'polygon':
    case 'polyline':
    case 'keypoints': {
      const pts = geometry.points;
      if (pts.length === 0) return { kind: 'bbox', x: 0, y: 0, width: 0, height: 0 };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of pts) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      return { kind: 'bbox', x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
  }
}

export function iou(a: BBoxGeometry, b: BBoxGeometry): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = boxArea(a) + boxArea(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Standard non-maximum suppression over scored boxes. */
export function nms<T extends { box: BBoxGeometry; score: number }>(items: T[], threshold: number, limit = Infinity): T[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const kept: T[] = [];
  for (const candidate of sorted) {
    if (kept.length >= limit) break;
    if (kept.every((k) => iou(k.box, candidate.box) <= threshold)) kept.push(candidate);
  }
  return kept;
}

export function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface Handle {
  index: number;
  /** 0..7 for bbox corners/edges, vertex index otherwise. */
  point: Point;
}

export const BBOX_HANDLES = [
  { key: 'nw', fx: 0, fy: 0 },
  { key: 'n', fx: 0.5, fy: 0 },
  { key: 'ne', fx: 1, fy: 0 },
  { key: 'e', fx: 1, fy: 0.5 },
  { key: 'se', fx: 1, fy: 1 },
  { key: 's', fx: 0.5, fy: 1 },
  { key: 'sw', fx: 0, fy: 1 },
  { key: 'w', fx: 0, fy: 0.5 },
] as const;

export function bboxHandles(box: BBoxGeometry): Handle[] {
  return BBOX_HANDLES.map((h, index) => ({
    index,
    point: { x: box.x + box.width * h.fx, y: box.y + box.height * h.fy },
  }));
}

/** Applies a handle drag, preserving the opposite corner/edge. */
export function resizeBox(
  box: BBoxGeometry,
  handleIndex: number,
  point: Point,
  minSize = 2,
): BBoxGeometry {
  let { x, y, width, height } = box;
  const right = x + width;
  const bottom = y + height;
  const key = BBOX_HANDLES[handleIndex].key;
  if (key.includes('w')) {
    x = Math.min(point.x, right - minSize);
    width = right - x;
  }
  if (key.includes('e')) {
    width = Math.max(minSize, point.x - x);
  }
  if (key.includes('n')) {
    y = Math.min(point.y, bottom - minSize);
    height = bottom - y;
  }
  if (key.includes('s')) {
    height = Math.max(minSize, point.y - y);
  }
  return { kind: 'bbox', x, y, width, height };
}

export function translateGeometry(geometry: Geometry, dx: number, dy: number): Geometry {
  const move = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  switch (geometry.kind) {
    case 'bbox':
      return { ...geometry, x: geometry.x + dx, y: geometry.y + dy };
    case 'polygon':
    case 'polyline':
    case 'keypoints':
      return { ...geometry, points: geometry.points.map(move) };
  }
}

export function scaleGeometry(geometry: Geometry, sx: number, sy: number): Geometry {
  switch (geometry.kind) {
    case 'bbox':
      return { kind: 'bbox', x: geometry.x * sx, y: geometry.y * sy, width: geometry.width * sx, height: geometry.height * sy };
    case 'polygon':
    case 'polyline':
    case 'keypoints':
      return { ...geometry, points: geometry.points.map((p) => ({ x: p.x * sx, y: p.y * sy })) };
  }
}

export function clampGeometryToImage(geometry: Geometry, width: number, height: number): Geometry {
  const c = (p: Point): Point => ({ x: clamp(p.x, 0, width), y: clamp(p.y, 0, height) });
  switch (geometry.kind) {
    case 'bbox': {
      const x = clamp(geometry.x, 0, width);
      const y = clamp(geometry.y, 0, height);
      return {
        kind: 'bbox',
        x,
        y,
        width: Math.min(geometry.width, width - x),
        height: Math.min(geometry.height, height - y),
      };
    }
    case 'polygon':
    case 'polyline':
    case 'keypoints':
      return { ...geometry, points: geometry.points.map(c) };
  }
}

/** Ramer–Douglas–Peucker simplification for traced masks and brush strokes. */
export function simplifyPolygon(points: Point[], epsilon = 1.5): Point[] {
  if (points.length <= 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = distanceToSegment(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > epsilon) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

export function isDegenerate(geometry: Geometry): boolean {
  switch (geometry.kind) {
    case 'bbox':
      return geometry.width < 2 || geometry.height < 2;
    case 'polygon':
      return geometry.points.length < 3 || polygonArea(geometry.points) < 4;
    case 'polyline':
      return geometry.points.length < 2;
    case 'keypoints':
      return geometry.points.length === 0;
  }
}

export function polygonCentroid(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

export function geometryArea(geometry: Geometry): number {
  if (geometry.kind === 'bbox') return boxArea(geometry);
  if (geometry.kind === 'polygon') return polygonArea(geometry.points);
  return 0;
}

/** Rotates points by 0/90/180/270 degrees inside a width x height frame. */
export function rotatePoint(p: Point, width: number, height: number, quarterTurns: number): Point {
  const t = ((quarterTurns % 4) + 4) % 4;
  switch (t) {
    case 1:
      return { x: height - p.y, y: p.x };
    case 2:
      return { x: width - p.x, y: height - p.y };
    case 3:
      return { x: p.y, y: width - p.x };
    default:
      return p;
  }
}

export function rotateGeometry(geometry: Geometry, width: number, height: number, quarterTurns: number): Geometry {
  const t = ((quarterTurns % 4) + 4) % 4;
  if (t === 0) return geometry;
  const rotatedSize = t % 2 === 0 ? { w: width, h: height } : { w: height, h: width };
  if (geometry.kind === 'bbox') {
    const corners = [
      rotatePoint({ x: geometry.x, y: geometry.y }, width, height, t),
      rotatePoint({ x: geometry.x + geometry.width, y: geometry.y + geometry.height }, width, height, t),
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { kind: 'bbox', x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  return {
    ...geometry,
    points: geometry.points.map((p) => {
      const r = rotatePoint(p, width, height, t);
      return { x: clamp(r.x, 0, rotatedSize.w), y: clamp(r.y, 0, rotatedSize.h) };
    }),
  };
}

export function formatBox(box: BBoxGeometry): string {
  return `${Math.round(box.x)}, ${Math.round(box.y)} · ${Math.round(box.width)}×${Math.round(box.height)}`;
}

export function geometryLabel(geometry: Geometry): string {
  switch (geometry.kind) {
    case 'bbox':
      return `rectangle ${Math.round(geometry.width)}×${Math.round(geometry.height)}`;
    case 'polygon':
      return `polygon with ${geometry.points.length} vertices`;
    case 'polyline':
      return `polyline with ${geometry.points.length} vertices`;
    case 'keypoints':
      return `${geometry.points.length} keypoints`;
  }
}

export function polygonToBBox(polygon: PolygonGeometry): BBoxGeometry {
  return bboxOfGeometry(polygon);
}
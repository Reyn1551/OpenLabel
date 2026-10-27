/**
 * Shared vocabulary for OpenLabel's offline team collaboration layer.
 *
 * Every replicated value is addressed by its **content**, not by a local
 * database id: images are keyed by the SHA-256 of their original bytes, so two
 * annotators who imported the same photo from a USB stick or a shared folder
 * converge even though their local image ids differ.
 *
 * All operations carry a {@link Stamp} (Lamport counter + peer id). Stamps are
 * totally ordered, which makes last-writer-wins deterministic on every replica.
 */

/** Stable identity for one browser profile (16 lowercase hex characters). */
export type PeerId = string;

/** Total order across replicas: counter first, peer id as tie-breaker. */
export interface Stamp {
  /** Lamport counter; monotonically increasing per peer. */
  t: number;
  /** Author of the operation. */
  p: PeerId;
}

/** Content address for an image: SHA-256 of the original bytes. */
export type ImageKey = string;

/**
 * Stable cross-replica identity for a class.
 *
 * Local class ids are generated per browser, so two annotators that imported
 * the same dataset independently have different ids for "car". The normalized
 * name is the only value both sides agree on: it is what the class key encodes.
 * Renaming a class therefore starts a new class identity, which is why the UI
 * treats renames as explicit project operations.
 */
export function classKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface SyncPoint {
  x: number;
  y: number;
}

export type SyncGeometry =
  | { kind: 'bbox'; x: number; y: number; width: number; height: number }
  | { kind: 'polygon'; points: SyncPoint[] }
  | { kind: 'keypoints'; points: SyncPoint[] }
  | { kind: 'polyline'; points: SyncPoint[] };

/** Portable annotation payload; local database ids are deliberately absent. */
export interface SyncAnnotation {
  /** Replicated annotation id, stable for the lifetime of the annotation. */
  id: string;
  /** Class identity from {@link classKey}; mapped to a local class id on apply. */
  classId: string;
  geometry: SyncGeometry;
  attributes: Record<string, string>;
  source: 'human' | 'auto' | 'import';
  confidence?: number;
  /** Author of the annotation (first writer), not the last editor. */
  author: PeerId;
  createdAt: number;
  updatedAt: number;
}

export interface SyncClass {
  id: string;
  name: string;
  color: string;
  keypoints?: string[];
}

/**
 * Image identity as peers need it for the assignment board. Pixels never travel
 * through this layer: `image` is the SHA-256 of the bytes each member already
 * has locally, so the same photo imported from a shared folder lines up.
 */
export interface SyncImageMeta {
  name: string;
  width: number;
  height: number;
  bytes: number;
  mime: string;
  createdAt: number;
  tags: string[];
}

export interface SyncProject {
  name: string;
  type: 'object-detection' | 'instance-segmentation' | 'keypoint' | 'classification';
  description: string;
  classes: SyncClass[];
  split: { train: number; valid: number; test: number };
}

export type Op =
  | { oid: string; k: 'ann.put'; s: Stamp; image: ImageKey; ann: SyncAnnotation }
  | { oid: string; k: 'ann.del'; s: Stamp; image: ImageKey; id: string }
  | { oid: string; k: 'img.meta'; s: Stamp; image: ImageKey; meta: SyncImageMeta }
  | { oid: string; k: 'img.claim'; s: Stamp; image: ImageKey; owner: PeerId | null }
  | { oid: string; k: 'img.done'; s: Stamp; image: ImageKey; done: boolean }
  | { oid: string; k: 'class.put'; s: Stamp; cls: SyncClass }
  | { oid: string; k: 'proj.put'; s: Stamp; project: SyncProject };

export type OpKind = Op['k'];

/** Highest Lamport counter observed per peer. */
export type VersionVector = Record<PeerId, number>;

/** Compares two stamps; negative when `a` happens before `b`. */
export function compareStamp(a: Stamp, b: Stamp): number {
  if (a.t !== b.t) return a.t - b.t;
  return a.p < b.p ? -1 : a.p > b.p ? 1 : 0;
}

export function sameStamp(a: Stamp, b: Stamp): boolean {
  return a.t === b.t && a.p === b.p;
}
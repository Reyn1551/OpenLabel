import { compareStamp } from './types';
import type {
  ImageKey,
  Op,
  PeerId,
  Stamp,
  SyncAnnotation,
  SyncClass,
  SyncImageMeta,
  SyncProject,
  VersionVector,
} from './types';

export interface AnnotationEntry {
  ann: SyncAnnotation;
  s: Stamp;
}

export interface ClaimEntry {
  owner: PeerId | null;
  s: Stamp;
}

export interface DoneEntry {
  done: boolean;
  s: Stamp;
}

export interface ClassEntry {
  cls: SyncClass;
  s: Stamp;
}

export interface ImageMetaEntry {
  meta: SyncImageMeta;
  s: Stamp;
}

export interface ProjectEntry {
  project: SyncProject;
  s: Stamp;
}

/**
 * Replicated state after applying a set of operations.
 *
 * Settlement rule shared by every collection: a write replaces the current
 * entry only when its stamp is strictly greater. `annotations` stores live
 * annotations, `tombstones` remembers deletions that may still be missing from
 * a peer's log, and the two are mutually exclusive per annotation key.
 */
export interface CollabState {
  vv: VersionVector;
  annotations: Map<string, AnnotationEntry>;
  tombstones: Map<string, Stamp>;
  images: Map<ImageKey, ImageMetaEntry>;
  claims: Map<ImageKey, ClaimEntry>;
  done: Map<ImageKey, DoneEntry>;
  classes: Map<string, ClassEntry>;
  project: ProjectEntry | null;
  /** Operation ids already incorporated; makes replay a no-op. */
  seen: Set<string>;
}

const KEY_SEPARATOR = '\u0000';

/** Annotation key: content-addressed image plus the replicated annotation id. */
export function annotationKey(image: ImageKey, id: string): string {
  return `${image}${KEY_SEPARATOR}${id}`;
}

function isNewer(candidate: Stamp, current: Stamp | undefined): boolean {
  return current === undefined || compareStamp(candidate, current) > 0;
}

export function emptyState(): CollabState {
  return {
    vv: {},
    annotations: new Map(),
    tombstones: new Map(),
    images: new Map(),
    claims: new Map(),
    done: new Map(),
    classes: new Map(),
    project: null,
    seen: new Set(),
  };
}

/**
 * Structural copy for transactional application. Entry payloads are treated as
 * immutable by this module, so entries and their maps are copied while the
 * payload objects are shared.
 */
export function cloneState(state: CollabState): CollabState {
  return {
    vv: { ...state.vv },
    annotations: new Map(state.annotations),
    tombstones: new Map(state.tombstones),
    images: new Map(state.images),
    claims: new Map(state.claims),
    done: new Map(state.done),
    classes: new Map(state.classes),
    project: state.project,
    seen: new Set(state.seen),
  };
}

/**
 * Applies one operation in place. Returns false when the operation is a replay
 * or loses last-writer-wins against what the state already knows.
 *
 * Rejected operations still advance `vv` and `seen`: the replica has observed
 * them, so anti-entropy must not send them again.
 */
export function applyOp(state: CollabState, op: Op): boolean {
  if (state.seen.has(op.oid)) return false;
  state.seen.add(op.oid);
  if (op.s.t > (state.vv[op.s.p] ?? 0)) state.vv[op.s.p] = op.s.t;

  switch (op.k) {
    case 'ann.put': {
      const key = annotationKey(op.image, op.ann.id);
      const tombstone = state.tombstones.get(key);
      if (tombstone && !isNewer(op.s, tombstone)) return false;
      const current = state.annotations.get(key);
      if (!isNewer(op.s, current?.s)) return false;
      state.annotations.set(key, { ann: op.ann, s: op.s });
      state.tombstones.delete(key);
      return true;
    }
    case 'ann.del': {
      const key = annotationKey(op.image, op.id);
      const current = state.annotations.get(key);
      if (current && !isNewer(op.s, current.s)) return false;
      if (!isNewer(op.s, state.tombstones.get(key))) return false;
      state.annotations.delete(key);
      state.tombstones.set(key, op.s);
      return true;
    }
    case 'img.meta': {
      if (!isNewer(op.s, state.images.get(op.image)?.s)) return false;
      state.images.set(op.image, { meta: op.meta, s: op.s });
      return true;
    }
    case 'img.claim': {
      if (!isNewer(op.s, state.claims.get(op.image)?.s)) return false;
      state.claims.set(op.image, { owner: op.owner, s: op.s });
      return true;
    }
    case 'img.done': {
      if (!isNewer(op.s, state.done.get(op.image)?.s)) return false;
      state.done.set(op.image, { done: op.done, s: op.s });
      return true;
    }
    case 'class.put': {
      if (!isNewer(op.s, state.classes.get(op.cls.id)?.s)) return false;
      state.classes.set(op.cls.id, { cls: op.cls, s: op.s });
      return true;
    }
    case 'proj.put': {
      if (state.project && !isNewer(op.s, state.project.s)) return false;
      state.project = { project: op.project, s: op.s };
      return true;
    }
  }
}

/** Pure batch application: clones, applies in log order, returns the copy. */
export function applyOps(state: CollabState, ops: readonly Op[]): CollabState {
  const next = cloneState(state);
  for (const op of ops) applyOp(next, op);
  return next;
}

export interface MaterializedState {
  annotationsByImage: Map<ImageKey, SyncAnnotation[]>;
  images: Map<ImageKey, SyncImageMeta>;
  claims: Map<ImageKey, PeerId | null>;
  done: Map<ImageKey, boolean>;
  classes: SyncClass[];
  project: SyncProject | null;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Read model for the UI. Ordering is derived from content, never from map
 * insertion order, so replicas that applied the log in different orders still
 * materialize identically.
 */
export function materialize(state: CollabState): MaterializedState {
  const annotationsByImage = new Map<ImageKey, SyncAnnotation[]>();
  for (const [key, entry] of state.annotations) {
    const image = key.slice(0, key.indexOf(KEY_SEPARATOR));
    let list = annotationsByImage.get(image);
    if (!list) {
      list = [];
      annotationsByImage.set(image, list);
    }
    list.push(entry.ann);
  }
  for (const list of annotationsByImage.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt || compareText(a.id, b.id));
  }

  const images = new Map<ImageKey, SyncImageMeta>();
  for (const image of [...state.images.keys()].sort(compareText)) {
    images.set(image, state.images.get(image)!.meta);
  }

  const claims = new Map<ImageKey, PeerId | null>();
  for (const [image, entry] of state.claims) claims.set(image, entry.owner);

  const done = new Map<ImageKey, boolean>();
  for (const [image, entry] of state.done) done.set(image, entry.done);

  const classes = [...state.classes.values()]
    .map((entry) => entry.cls)
    .sort((a, b) => compareText(a.id, b.id));

  return {
    annotationsByImage,
    images,
    claims,
    done,
    classes,
    project: state.project ? state.project.project : null,
  };
}

export function versionVector(state: CollabState): VersionVector {
  return { ...state.vv };
}

/** Operations the owner of `vv` has not observed yet, in log order. */
export function opsSince(log: readonly Op[], vv: VersionVector): Op[] {
  return log.filter((op) => op.s.t > (vv[op.s.p] ?? 0));
}
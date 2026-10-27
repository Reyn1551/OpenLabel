import { useStudio } from '@/core/store';
import { replaceImageAnnotations } from '@/core/repo';
import type { Annotation, Geometry, ImageMeta } from '@/core/types';
import { materialize, type CollabState } from './state';
import type { CollabSession } from './session';
import {
  classKey,
  type ImageKey,
  type Op,
  type Stamp,
  type SyncAnnotation,
  type SyncGeometry,
} from './types';

/**
 * Bridges the annotation studio (local IndexedDB store) with one collaboration
 * session.
 *
 * Local edits are diffed against the last broadcast snapshot and submitted as
 * operations; remote operations are written back into IndexedDB and into the
 * studio's in-memory state. The bridge never emits operations for state it just
 * received, so two replicas cannot ping-pong forever.
 */

/** Operations per submit; a 5000-image project seeds in bounded batches. */
const SUBMIT_CHUNK = 200;

function toSyncGeometry(geometry: Geometry): SyncGeometry {
  switch (geometry.kind) {
    case 'bbox':
      return { kind: 'bbox', x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
    default:
      return { kind: geometry.kind, points: geometry.points.map((point) => ({ x: point.x, y: point.y })) };
  }
}

function toLocalGeometry(geometry: SyncGeometry): Geometry {
  switch (geometry.kind) {
    case 'bbox':
      return { kind: 'bbox', x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
    default:
      return { kind: geometry.kind, points: geometry.points.map((point) => ({ x: point.x, y: point.y })) };
  }
}

function toSyncAnnotation(annotation: Annotation, keyById: Map<string, string>, author: string): SyncAnnotation {
  return {
    id: annotation.id,
    classId: keyById.get(annotation.classId) ?? classKey(annotation.classId),
    geometry: toSyncGeometry(annotation.geometry),
    attributes: { ...annotation.attributes },
    source: annotation.source,
    confidence: annotation.confidence,
    author,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
  };
}

function toLocalAnnotation(
  synced: SyncAnnotation,
  image: ImageMeta,
  projectId: string,
  classIdByKey: Map<string, string>,
): Annotation | null {
  const classId = classIdByKey.get(synced.classId);
  if (!classId) return null;
  return {
    id: synced.id,
    projectId,
    imageId: image.id,
    classId,
    geometry: toLocalGeometry(synced.geometry),
    attributes: { ...synced.attributes },
    source: synced.source,
    confidence: synced.confidence,
    createdAt: synced.createdAt,
    updatedAt: synced.updatedAt,
  };
}

function sameAnnotations(a: Annotation[], b: Annotation[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((annotation) => [annotation.id, annotation.updatedAt]));
  return b.every((annotation) => byId.get(annotation.id) === annotation.updatedAt);
}

export interface StudioBridge {
  /** Stops watching; the session itself stays open. */
  stop(): void;
  /** Forces a diff pass, e.g. after the studio finished loading a project. */
  flush(): void;
}

export function startStudioBridge(session: CollabSession): StudioBridge {
  const projectId = session.projectId;
  const lastAnn = new Map<string, Map<string, number>>();
  const lastList = new Map<string, Annotation[]>();
  const lastClass = new Map<string, string>();
  const lastImage = new Set<ImageKey>();
  let applying = false;
  let lastApplied: CollabState | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const makeOp = (kind: Op['k'], build: (stamp: Stamp, oid: string) => Op): Op => {
    const stamp = session.nextStamp();
    return build(stamp, `${stamp.p}:${stamp.t}:${kind}`);
  };

  const syncLocal = () => {
    if (applying) return;
    const state = useStudio.getState();
    const project = state.project;
    if (!project || project.id !== projectId) return;

    const ops: Op[] = [];
    const keyById = new Map<string, string>();
    for (const cls of project.classes) {
      const key = classKey(cls.name);
      keyById.set(cls.id, key);
      const next = JSON.stringify([cls.name, cls.color, cls.keypoints ?? []]);
      if (lastClass.get(key) === next) continue;
      lastClass.set(key, next);
      ops.push(
        makeOp('class.put', (stamp, oid) => ({
          oid,
          k: 'class.put',
          s: stamp,
          cls: { id: key, name: cls.name, color: cls.color, keypoints: cls.keypoints },
        })),
      );
    }

    for (const image of state.images) {
      if (image.projectId !== projectId) continue;
      if (lastImage.has(image.hash)) continue;
      lastImage.add(image.hash);
      ops.push(
        makeOp('img.meta', (stamp, oid) => ({
          oid,
          k: 'img.meta',
          s: stamp,
          image: image.hash,
          meta: {
            name: image.name,
            width: image.width,
            height: image.height,
            bytes: image.bytes,
            mime: image.mime,
            createdAt: image.createdAt,
            tags: image.tags,
          },
        })),
      );
    }

    for (const image of state.images) {
      if (image.projectId !== projectId) continue;
      const list = state.annotations[image.id] ?? [];
      if (lastList.get(image.id) === list) continue;
      const previous = lastAnn.get(image.id) ?? new Map<string, number>();
      const next = new Map<string, number>();
      for (const annotation of list) {
        next.set(annotation.id, annotation.updatedAt);
        if (previous.get(annotation.id) === annotation.updatedAt) continue;
        ops.push(
          makeOp('ann.put', (stamp, oid) => ({
            oid,
            k: 'ann.put',
            s: stamp,
            image: image.hash,
            ann: toSyncAnnotation(annotation, keyById, session.peer),
          })),
        );
      }
      for (const id of previous.keys()) {
        if (next.has(id)) continue;
        ops.push(makeOp('ann.del', (stamp, oid) => ({ oid, k: 'ann.del', s: stamp, image: image.hash, id })));
      }
      lastAnn.set(image.id, next);
      lastList.set(image.id, list);
    }

    for (let index = 0; index < ops.length; index += SUBMIT_CHUNK) {
      session.submit(ops.slice(index, index + SUBMIT_CHUNK));
    }
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      syncLocal();
    }, 0);
  };

  /** Writes the merged view back into IndexedDB and the live studio state. */
  const applyRemote = (state: CollabState) => {
    if (state === lastApplied) return;
    lastApplied = state;
    const studio = useStudio.getState();
    const project = studio.project;
    if (!project || project.id !== projectId) return;

    const byHash = new Map(studio.images.map((image) => [image.hash, image]));
    const classIdByKey = new Map(project.classes.map((cls) => [classKey(cls.name), cls.id]));
    const merged = materialize(state);

    applying = true;
    try {
      for (const [hash, list] of merged.annotationsByImage) {
        const image = byHash.get(hash);
        if (!image) continue;
        const desired = list
          .map((synced) => toLocalAnnotation(synced, image, projectId, classIdByKey))
          .filter((annotation): annotation is Annotation => annotation !== null);
        const current = studio.annotations[image.id] ?? [];
        if (sameAnnotations(current, desired)) continue;
        lastAnn.set(image.id, new Map(desired.map((annotation) => [annotation.id, annotation.updatedAt])));
        lastList.set(image.id, desired);
        void replaceImageAnnotations(image.id, desired);
        useStudio.setState((prev) => ({
          annotations: { ...prev.annotations, [image.id]: desired },
          images: prev.images.map((candidate) =>
            candidate.id === image.id ? { ...candidate, annotationCount: desired.length } : candidate,
          ),
        }));
      }
    } finally {
      applying = false;
    }
  };

  const unsubscribeStudio = useStudio.subscribe(schedule);
  const unsubscribeSession = session.subscribe((snapshot) => applyRemote(snapshot.state));
  schedule();

  return {
    stop: () => {
      unsubscribeStudio();
      unsubscribeSession();
      clearTimeout(timer);
      timer = undefined;
    },
    flush: schedule,
  };
}

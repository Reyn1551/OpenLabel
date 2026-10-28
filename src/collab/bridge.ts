import { useStudio } from '@/core/store';
import {
  ensureProjectShell,
  getProject,
  listAnnotations,
  listAnnotationsForImage,
  listImages,
  replaceImageAnnotations,
  saveImageMeta,
  saveProject,
  uid,
} from '@/core/repo';
import type { Annotation, Geometry, ImageMeta, Project } from '@/core/types';
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

export interface StudioBridgeOptions {
  /**
   * Asks every connected peer for an image this device is missing. The runtime
   * wires this to the blob channel of each WebRTC pair.
   */
  requestBlob?: (hash: string) => void;
}

export function startStudioBridge(session: CollabSession, options: StudioBridgeOptions = {}): StudioBridge {
  const projectId = session.projectId;
  const lastAnn = new Map<string, Map<string, number>>();
  const lastList = new Map<string, Annotation[]>();
  const lastClass = new Map<string, string>();
  const lastImage = new Set<ImageKey>();
  let lastProjectJson = '';
  let applying = false;
  let lastApplied: CollabState | null = null;
  /** Remote state that arrived before the local project was seeded. */
  let pendingRemote: CollabState | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seeded = false;
  let imageCache: Map<string, ImageMeta> | null = null;
  let imageCacheSize = -1;

  const makeOp = (kind: Op['k'], build: (stamp: Stamp, oid: string) => Op): Op => {
    const stamp = session.nextStamp();
    return build(stamp, `${stamp.p}:${stamp.t}:${kind}`);
  };

  /**
   * Emits operations for the difference between the given project snapshot and
   * what was already broadcast.
   *
   * Both sources feed this: the live studio store while annotating, and
   * IndexedDB when the session starts on a route that never mounted the studio
   * (opening Team first is a normal flow).
   */
  const emitState = (
    project: Project,
    images: ImageMeta[],
    listFor: (imageId: string) => Annotation[] | undefined,
  ): Op[] => {
    const ops: Op[] = [];
    const keyById = new Map<string, string>();

    // Project metadata travels first so a peer that joins cold has a name, type
    // and split before classes and annotations reference them.
    const projectJson = JSON.stringify([project.name, project.type, project.description, project.split]);
    if (lastProjectJson !== projectJson) {
      lastProjectJson = projectJson;
      ops.push(
        makeOp('proj.put', (stamp, oid) => ({
          oid,
          k: 'proj.put',
          s: stamp,
          project: {
            name: project.name,
            type: project.type,
            description: project.description,
            classes: [],
            split: project.split,
          },
        })),
      );
    }

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

    for (const image of images) {
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

    for (const image of images) {
      if (image.projectId !== projectId) continue;
      const list = listFor(image.id) ?? [];
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
    return ops;
  };

  const submit = (ops: Op[]) => {
    for (let index = 0; index < ops.length; index += SUBMIT_CHUNK) {
      session.submit(ops.slice(index, index + SUBMIT_CHUNK));
    }
  };

  const syncLocal = () => {
    if (applying || !seeded) return;
    const state = useStudio.getState();
    const project = state.project;
    if (!project || project.id !== projectId) return;
    submit(emitState(project, state.images, (imageId) => state.annotations[imageId] ?? []));
  };

  /**
   * Seeds the session from IndexedDB once, so a project that was never opened in
   * the studio still reaches peers.
   */
  const seedFromDatabase = async () => {
    try {
      const [project, images, annotations] = await Promise.all([
        getProject(projectId),
        listImages(projectId),
        listAnnotations(projectId),
      ]);
      if (!project) return;
      const byImage = new Map<string, Annotation[]>();
      for (const annotation of annotations) {
        const list = byImage.get(annotation.imageId);
        if (list) list.push(annotation);
        else byImage.set(annotation.imageId, [annotation]);
      }
      submit(emitState(project, images, (imageId) => byImage.get(imageId) ?? []));
    } catch {
      // Seeding is best effort; the studio still seeds once it is opened.
    } finally {
      seeded = true;
      schedule();
      const pending = pendingRemote;
      pendingRemote = null;
      if (pending) scheduleApply(pending);
    }
  };

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      syncLocal();
    }, 0);
  }

  /** Creates or extends the local project row from replicated metadata. */
  const ensureLocalProject = async (
    merged: ReturnType<typeof materialize>,
  ): Promise<{ project: Project; classIdByKey: Map<string, string> }> => {
    let project = await getProject(projectId);
    if (!project) {
      project = await ensureProjectShell({
        id: projectId,
        name: merged.project?.name,
        type: merged.project?.type,
        description: merged.project?.description,
        split: merged.project?.split,
      });
    }

    const byKey = new Map(project.classes.map((cls) => [classKey(cls.name), cls]));
    let changed = false;
    for (const cls of merged.classes) {
      if (byKey.has(cls.id)) continue;
      byKey.set(cls.id, { id: uid('cls'), name: cls.name, color: cls.color, keypoints: cls.keypoints });
      changed = true;
    }
    if (changed) project = await saveProject({ ...project, classes: [...byKey.values()] });

    return {
      project,
      classIdByKey: new Map([...byKey.entries()].map(([key, cls]) => [key, cls.id])),
    };
  };

  /**
   * Adds rows for images the peer has but this device does not. The pixels are
   * requested separately; the row makes the work-split board and the annotation
   * mappings usable immediately.
   */
  const ensureRemoteImages = async (
    merged: ReturnType<typeof materialize>,
  ): Promise<Map<string, ImageMeta>> => {
    const byHash = new Map((await listImages(projectId)).map((image) => [image.hash, image]));
    for (const [hash, meta] of merged.images) {
      if (byHash.has(hash)) continue;
      const image: ImageMeta = {
        id: uid('img'),
        projectId,
        name: meta.name,
        width: meta.width,
        height: meta.height,
        bytes: meta.bytes,
        mime: meta.mime,
        hash,
        createdAt: meta.createdAt,
        tags: [...meta.tags],
        batchId: null,
        split: null,
        pHash: '',
        descriptor: [],
        annotationCount: 0,
        note: '',
      };
      await saveImageMeta(image);
      byHash.set(hash, image);
      options.requestBlob?.(hash);
    }
    return byHash;
  };

  /**
   * Writes the merged view into IndexedDB and, when the studio is mounted,
   * mirrors it into the live store.
   *
   * IndexedDB is the source of truth here, not the store: the Team page and a
   * reload both need the merged data, and neither implies a mounted studio. A
   * peer that joins a project it has never opened gets the project row, its
   * classes, its images and its annotations from this path.
   */
  const applyRemote = async (state: CollabState): Promise<void> => {
    // Applying before seeding would replace local annotations with a state that
    // does not contain them yet, deleting work that was never broadcast.
    if (!seeded) {
      pendingRemote = state;
      return;
    }
    if (state === lastApplied) return;
    lastApplied = state;

    const merged = materialize(state);
    const { project, classIdByKey } = await ensureLocalProject(merged);

    // `listImages` walks every row, so rebuild the map only when the set of
    // replicated images actually changed.
    if (!imageCache || imageCacheSize !== merged.images.size) {
      imageCache = await ensureRemoteImages(merged);
      imageCacheSize = merged.images.size;
    }
    const byHash = imageCache;

    applying = true;
    try {
      for (const [hash, list] of merged.annotationsByImage) {
        const image = byHash.get(hash);
        if (!image) continue;
        const desired = list
          .map((synced) => toLocalAnnotation(synced, image, projectId, classIdByKey))
          .filter((annotation): annotation is Annotation => annotation !== null);

        // The last write is already in the store, so comparing against it avoids
        // one IndexedDB read per image on every frame.
        const cached = lastList.get(image.id);
        if (cached && sameAnnotations(cached, desired)) continue;

        const current = cached ?? (await listAnnotationsForImage(image.id));
        if (sameAnnotations(current, desired)) continue;
        lastAnn.set(image.id, new Map(desired.map((annotation) => [annotation.id, annotation.updatedAt])));
        lastList.set(image.id, desired);
        await replaceImageAnnotations(image.id, desired);

        const studio = useStudio.getState();
        if (studio.project?.id !== projectId) continue;
        useStudio.setState((prev) => ({
          annotations: { ...prev.annotations, [image.id]: desired },
          images: prev.images.map((candidate) =>
            candidate.id === image.id ? { ...candidate, annotationCount: desired.length } : candidate,
          ),
        }));
      }

      const studio = useStudio.getState();
      if (studio.project?.id === projectId && studio.project.classes.length !== project.classes.length) {
        useStudio.setState({ project });
      }
    } finally {
      applying = false;
    }
  };

  /** Serializes apply passes so two fast frames cannot interleave writes. */
  let applyingQueue: Promise<void> = Promise.resolve();
  const scheduleApply = (state: CollabState): void => {
    applyingQueue = applyingQueue.then(() => applyRemote(state)).catch(() => undefined);
  };

  const unsubscribeStudio = useStudio.subscribe(schedule);
  const unsubscribeSession = session.subscribe((snapshot) => scheduleApply(snapshot.state));
  void seedFromDatabase();

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

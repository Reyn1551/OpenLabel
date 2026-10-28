import { getDB } from './db';
import type {
  Annotation,
  DatasetVersion,
  ImageMeta,
  ModelBundle,
  Project,
  SplitName,
} from './types';
import { DEFAULT_AUTO_LABEL, DEFAULT_AUGMENT, DEFAULT_PREPROCESS } from './types';

export const uid = (prefix = ''): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return prefix ? `${prefix}_${hex}` : hex;
};

export const now = (): number => Date.now();

/**
 * Okabe–Ito colour-blind-safe palette (Wong, Nat Methods 2011), with the teal
 * and black slots swapped out: teal would collide with the accent and black is
 * invisible on dark photos. Hue is never the only channel: every shape also
 * renders its class name, so the palette stays legible for deuteranopia.
 */
const PALETTE = [
  '#d55e00', '#e69f00', '#f0e442', '#3f8f52',
  '#0072b2', '#56b4e9', '#cc79a7', '#4a5058',
];

export function classColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

export async function listProjects(): Promise<Project[]> {
  const db = await getDB();
  const projects = await db.getAll('projects');
  return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<Project | undefined> {
  const db = await getDB();
  return db.get('projects', id);
}

export async function createProject(input: {
  name: string;
  type: Project['type'];
  description?: string;
  classes?: string[];
}): Promise<Project> {
  const db = await getDB();
  const timestamp = now();
  const project: Project = {
    id: uid('prj'),
    name: input.name.trim() || 'Untitled project',
    type: input.type,
    description: input.description?.trim() ?? '',
    classes: (input.classes ?? []).filter(Boolean).map((name, index) => ({
      id: uid('cls'),
      name,
      color: classColor(index),
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
    split: { train: 70, valid: 20, test: 10 },
    autoLabel: { ...DEFAULT_AUTO_LABEL },
  };
  await db.put('projects', project);
  return project;
}

export async function saveProject(project: Project): Promise<Project> {
  const db = await getDB();
  const next = { ...project, updatedAt: now() };
  await db.put('projects', next);
  return next;
}

export async function updateProject(id: string, patch: Partial<Project>): Promise<Project> {
  const db = await getDB();
  const existing = await db.get('projects', id);
  if (!existing) throw new Error(`Project ${id} not found`);
  const next: Project = { ...existing, ...patch, id, updatedAt: now() };
  await db.put('projects', next);
  return next;
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['projects', 'images', 'blobs', 'annotations', 'versions', 'models'], 'readwrite');
  const imageIds = await tx.objectStore('images').index('by-project').getAllKeys(id);
  for (const imageId of imageIds) {
    tx.objectStore('images').delete(imageId);
    tx.objectStore('blobs').delete(imageId);
  }
  const annotationKeys = await tx.objectStore('annotations').index('by-project').getAllKeys(id);
  for (const key of annotationKeys) tx.objectStore('annotations').delete(key);
  const versionKeys = await tx.objectStore('versions').index('by-project').getAllKeys(id);
  for (const key of versionKeys) tx.objectStore('versions').delete(key);
  const modelKeys = await tx.objectStore('models').index('by-project').getAllKeys(id);
  for (const key of modelKeys) tx.objectStore('models').delete(key);
  tx.objectStore('projects').delete(id);
  await tx.done;
}

export async function listImages(projectId: string): Promise<ImageMeta[]> {
  const db = await getDB();
  const images = await db.getAllFromIndex('images', 'by-project', projectId);
  return images.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getImage(id: string): Promise<ImageMeta | undefined> {
  const db = await getDB();
  return db.get('images', id);
}

/** Content-addressed lookup: peers name images by the SHA-256 of their bytes. */
export async function getImageByHash(hash: string): Promise<ImageMeta | undefined> {
  const db = await getDB();
  return db.getFromIndex('images', 'by-hash', hash);
}

/**
 * Creates a project row with a caller-supplied id.
 *
 * A peer that joins a shared project through an invite link has the project id
 * before it has any of the project's data, so this is the only way to open the
 * route and let replication fill the rest in.
 */
export async function ensureProjectShell(input: {
  id: string;
  name?: string;
  type?: Project['type'];
  description?: string;
  split?: Project['split'];
}): Promise<Project> {
  const existing = await getProject(input.id);
  if (existing) return existing;

  const timestamp = now();
  const project: Project = {
    id: input.id,
    name: input.name?.trim() || 'Shared project',
    type: input.type ?? 'object-detection',
    description: input.description ?? '',
    classes: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    split: input.split ? { ...input.split } : { train: 70, valid: 20, test: 10 },
    autoLabel: { ...DEFAULT_AUTO_LABEL },
  };
  const db = await getDB();
  await db.put('projects', project);
  return project;
}

export async function getImageBlob(id: string): Promise<Blob | undefined> {
  const db = await getDB();
  const record = await db.get('blobs', id);
  return record?.blob;
}

export async function getImageThumb(id: string): Promise<Blob | undefined> {
  const db = await getDB();
  const record = await db.get('blobs', id);
  return record?.thumb;
}

export async function putImages(
  images: { meta: ImageMeta; blob: Blob; thumb: Blob }[],
): Promise<void> {
  if (images.length === 0) return;
  const db = await getDB();
  const tx = db.transaction(['images', 'blobs'], 'readwrite');
  for (const item of images) {
    tx.objectStore('images').put(item.meta);
    tx.objectStore('blobs').put({ id: item.meta.id, blob: item.blob, thumb: item.thumb });
  }
  await tx.done;
}

export async function saveImageMeta(meta: ImageMeta): Promise<void> {
  const db = await getDB();
  await db.put('images', meta);
}

export async function deleteImages(projectId: string, imageIds: string[]): Promise<void> {
  if (imageIds.length === 0) return;
  const db = await getDB();
  const tx = db.transaction(['images', 'blobs', 'annotations'], 'readwrite');
  for (const id of imageIds) {
    tx.objectStore('images').delete(id);
    tx.objectStore('blobs').delete(id);
    const keys = await tx.objectStore('annotations').index('by-image').getAllKeys(id);
    for (const key of keys) tx.objectStore('annotations').delete(key);
  }
  await tx.done;
  void projectId;
}

export async function listAnnotations(projectId: string): Promise<Annotation[]> {
  const db = await getDB();
  return db.getAllFromIndex('annotations', 'by-project', projectId);
}

export async function listAnnotationsForImage(imageId: string): Promise<Annotation[]> {
  const db = await getDB();
  return db.getAllFromIndex('annotations', 'by-image', imageId);
}

export async function putAnnotations(annotations: Annotation[]): Promise<void> {
  if (annotations.length === 0) return;
  const db = await getDB();
  const tx = db.transaction(['annotations', 'images'], 'readwrite');
  const counts = new Map<string, number>();
  for (const annotation of annotations) {
    tx.objectStore('annotations').put(annotation);
    counts.set(annotation.imageId, 0);
  }
  // Recount affected images inside the same transaction for consistency.
  const byImage = new Map<string, Annotation[]>();
  for (const imageId of counts.keys()) {
    byImage.set(imageId, await tx.objectStore('annotations').index('by-image').getAll(imageId));
  }
  for (const [imageId, list] of byImage) {
    const image = await tx.objectStore('images').get(imageId);
    if (image) tx.objectStore('images').put({ ...image, annotationCount: list.length });
  }
  await tx.done;
}

export async function deleteAnnotations(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDB();
  const tx = db.transaction(['annotations', 'images'], 'readwrite');
  const affected = new Set<string>();
  for (const id of ids) {
    const annotation = await tx.objectStore('annotations').get(id);
    if (annotation) {
      affected.add(annotation.imageId);
      tx.objectStore('annotations').delete(id);
    }
  }
  for (const imageId of affected) {
    const remaining = await tx.objectStore('annotations').index('by-image').getAll(imageId);
    const image = await tx.objectStore('images').get(imageId);
    if (image) tx.objectStore('images').put({ ...image, annotationCount: remaining.length });
  }
  await tx.done;
}

/** Replaces every annotation of one image; used by undo/redo and auto-label accept. */
export async function replaceImageAnnotations(imageId: string, annotations: Annotation[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['annotations', 'images'], 'readwrite');
  const existing = await tx.objectStore('annotations').index('by-image').getAllKeys(imageId);
  for (const key of existing) tx.objectStore('annotations').delete(key);
  for (const annotation of annotations) tx.objectStore('annotations').put(annotation);
  const image = await tx.objectStore('images').get(imageId);
  if (image) tx.objectStore('images').put({ ...image, annotationCount: annotations.length });
  await tx.done;
}

export async function recomputeAnnotationCounts(projectId: string): Promise<void> {
  const db = await getDB();
  const images = await db.getAllFromIndex('images', 'by-project', projectId);
  const annotations = await db.getAllFromIndex('annotations', 'by-project', projectId);
  const counts = new Map<string, number>();
  for (const annotation of annotations) {
    counts.set(annotation.imageId, (counts.get(annotation.imageId) ?? 0) + 1);
  }
  const tx = db.transaction('images', 'readwrite');
  for (const image of images) tx.objectStore('images').put({ ...image, annotationCount: counts.get(image.id) ?? 0 });
  await tx.done;
}

export function createVersion(input: {
  project: Project;
  images: ImageMeta[];
  annotations: Annotation[];
  name: string;
  number: number;
  preprocess: DatasetVersion['preprocess'];
  augment: DatasetVersion['augment'];
  notes?: string;
}): DatasetVersion {
  const classCounts: Record<string, number> = {};
  for (const cls of input.project.classes) classCounts[cls.id] = 0;
  for (const annotation of input.annotations) {
    classCounts[annotation.classId] = (classCounts[annotation.classId] ?? 0) + 1;
  }
  const splitCounts: Record<SplitName, number> = { train: 0, valid: 0, test: 0 };
  input.images.forEach((image, index) => {
    const split = image.split ?? assignSplit(index, input.project.split);
    splitCounts[split] += 1;
  });
  return {
    id: uid('ver'),
    projectId: input.project.id,
    name: input.name,
    number: input.number,
    createdAt: now(),
    imageCount: input.images.length,
    annotationCount: input.annotations.length,
    classCounts,
    splitCounts,
    split: input.project.split,
    preprocess: input.preprocess ?? DEFAULT_PREPROCESS,
    augment: input.augment ?? DEFAULT_AUGMENT,
    imageIds: input.images.map((i) => i.id),
    notes: input.notes ?? '',
  };
}

export function assignSplit(index: number, split: Project['split']): SplitName {
  const total = split.train + split.valid + split.test || 100;
  const position = ((index * 7919) % 100) + 0.5; // deterministic and interleaved
  const trainCut = (split.train / total) * 100;
  const validCut = trainCut + (split.valid / total) * 100;
  if (position < trainCut) return 'train';
  if (position < validCut) return 'valid';
  return 'test';
}

export async function listVersions(projectId: string): Promise<DatasetVersion[]> {
  const db = await getDB();
  const versions = await db.getAllFromIndex('versions', 'by-project', projectId);
  return versions.sort((a, b) => b.number - a.number);
}

export async function saveVersion(version: DatasetVersion): Promise<void> {
  const db = await getDB();
  await db.put('versions', version);
}

export async function deleteVersion(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('versions', id);
}

export async function getVersion(id: string): Promise<DatasetVersion | undefined> {
  const db = await getDB();
  return db.get('versions', id);
}

export async function saveModel(model: ModelBundle): Promise<void> {
  const db = await getDB();
  await db.put('models', model);
}

export async function listModels(projectId: string): Promise<ModelBundle[]> {
  const db = await getDB();
  const models = await db.getAllFromIndex('models', 'by-project', projectId);
  return models.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteModel(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('models', id);
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await getDB();
  return db.get('meta', key) as Promise<T | undefined>;
}

export async function setMeta<T>(key: string, value: T): Promise<void> {
  const db = await getDB();
  await db.put('meta', value, key);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { usage: 0, quota: 0 };
  }
  const estimate = await navigator.storage.estimate();
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}
export async function countImages(projectId: string): Promise<number> {
  const db = await getDB();
  return db.countFromIndex('images', 'by-project', projectId);
}

export async function countAnnotations(projectId: string): Promise<number> {
  const db = await getDB();
  return db.countFromIndex('annotations', 'by-project', projectId);
}

export async function latestVersionNumber(projectId: string): Promise<number> {
  const versions = await listVersions(projectId);
  return versions[0]?.number ?? 0;
}

export interface ProjectSummary {
  project: Project;
  imageCount: number;
  annotationCount: number;
  versionCount: number;
  modelCount: number;
}

export async function projectSummaries(): Promise<ProjectSummary[]> {
  const projects = await listProjects();
  const summaries = await Promise.all(
    projects.map(async (project) => ({
      project,
      imageCount: await countImages(project.id),
      annotationCount: await countAnnotations(project.id),
      versionCount: (await listVersions(project.id)).length,
      modelCount: (await listModels(project.id)).length,
    })),
  );
  return summaries;
}

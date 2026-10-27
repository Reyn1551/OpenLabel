import { create } from 'zustand';
import type {
  Annotation,
  AutoLabelSettings,
  ClassDef,
  Geometry,
  ImageMeta,
  ModelBundle,
  Prediction,
  Project,
  SplitName,
} from './types';
import {
  deleteAnnotations,
  getImageBlob,
  getProject,
  listAnnotations,
  listImages,
  listModels,
  putAnnotations,
  replaceImageAnnotations,
  saveImageMeta,
  saveModel,
  saveProject,
  uid,
  now,
} from './repo';
import { filesFromZip, importFiles, type ImportResult } from './import';
import { autoLabelClient, type JobHandle, type JobProgress } from '@/autolabel/client';

export type Tool = 'select' | 'box' | 'polygon' | 'keypoint' | 'freehand' | 'wand' | 'pan';

export interface StudioEvent {
  id: number;
  kind: 'added' | 'deleted' | 'selected' | 'updated' | 'undo' | 'redo' | 'image';
  classId?: string;
  annotationKind?: string;
  count?: number;
  imageName?: string;
  imageIndex?: number;
  imageTotal?: number;
}

interface History {
  past: Annotation[][];
  future: Annotation[][];
}

interface BusyState {
  active: boolean;
  progress: number;
  message: string;
  stage: string;
}

export interface StudioState {
  project: Project | null;
  images: ImageMeta[];
  annotations: Record<string, Annotation[]>;
  histories: Record<string, History>;
  model: ModelBundle | null;
  predictions: Record<string, Prediction[]>;
  training: BusyState | null;
  batch: BusyState | null;
  error: string | null;

  loading: boolean;
  selectedImageId: string | null;
  selectedAnnotationId: string | null;
  tool: Tool;
  activeClassId: string | null;
  zoom: number;
  pan: { x: number; y: number };
  viewport: { width: number; height: number };
  fitNonce: number;
  showAnnotations: boolean;
  showConfidence: boolean;
  searching: boolean;
  event: StudioEvent | null;

  load: (projectId: string) => Promise<void>;
  unload: () => void;
  selectImage: (imageId: string) => void;
  setTool: (tool: Tool) => void;
  setActiveClass: (classId: string) => void;
  selectAnnotation: (annotationId: string | null) => void;
  setZoom: (zoom: number) => void;
  setPan: (pan: { x: number; y: number }) => void;
  setViewport: (width: number, height: number) => void;
  requestFit: () => void;
  setShowAnnotations: (value: boolean) => void;
  setShowConfidence: (value: boolean) => void;

  beginEdit: (imageId: string) => void;
  setLocalAnnotations: (imageId: string, annotations: Annotation[]) => void;
  addAnnotation: (geometry: Geometry, options?: { classId?: string; source?: Annotation['source']; confidence?: number }) => Annotation | null;
  updateAnnotation: (annotationId: string, geometry: Geometry, options?: { commit?: boolean }) => void;
  commitAnnotations: (imageId: string) => Promise<void>;
  deleteAnnotation: (annotationId: string) => Promise<void>;
  duplicateAnnotation: (annotationId: string) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;

  addClass: (name: string, keypoints?: string[]) => Promise<ClassDef | null>;
  updateClass: (classId: string, patch: Partial<ClassDef>) => Promise<void>;
  deleteClass: (classId: string) => Promise<void>;

  importImages: (files: File[]) => Promise<ImportResult | null>;
  setSplit: (imageId: string, split: SplitName | null) => Promise<void>;
  setTags: (imageId: string, tags: string[]) => Promise<void>;
  setNote: (imageId: string, note: string) => Promise<void>;
  refreshImages: () => Promise<void>;

  updateAutoLabel: (patch: Partial<AutoLabelSettings>) => Promise<void>;
  trainModel: (options?: { force?: boolean }) => Promise<void>;
  predictImage: (imageId?: string) => Promise<void>;
  predictUnlabeled: (options?: { autoAccept?: boolean }) => Promise<void>;
  acceptPrediction: (imageId: string, index: number) => Promise<void>;
  acceptAllPredictions: (imageId: string) => Promise<void>;
  discardPredictions: (imageId: string) => Promise<void>;
  cancelJob: () => void;
}

let eventSequence = 0;
let activeJob: JobHandle<unknown> | null = null;

const busyFromProgress = (progress: JobProgress): BusyState => ({
  active: true,
  progress: progress.progress,
  message: progress.message,
  stage: progress.stage,
});

function cloneAnnotations(list: Annotation[]): Annotation[] {
  return structuredClone(list);
}

function pushHistory(state: StudioState, imageId: string): History {
  const current = state.histories[imageId] ?? { past: [], future: [] };
  const snapshot = cloneAnnotations(state.annotations[imageId] ?? []);
  return {
    past: [...current.past.slice(-49), snapshot],
    future: [],
  };
}

function withAnnotationCount(images: ImageMeta[], imageId: string, count: number): ImageMeta[] {
  return images.map((image) => (image.id === imageId ? { ...image, annotationCount: count } : image));
}

function toAnnotation(projectId: string, imageId: string, prediction: Prediction): Annotation {
  return {
    id: uid('ann'),
    projectId,
    imageId,
    classId: prediction.classId,
    geometry: prediction.geometry,
    attributes: {},
    source: 'auto',
    confidence: prediction.score,
    createdAt: now(),
    updatedAt: now(),
  };
}

export const useStudio = create<StudioState>((set, get) => ({
  project: null,
  images: [],
  annotations: {},
  histories: {},
  model: null,
  predictions: {},
  training: null,
  batch: null,
  error: null,
  loading: false,
  selectedImageId: null,
  selectedAnnotationId: null,
  tool: 'box',
  activeClassId: null,
  zoom: 1,
  pan: { x: 0, y: 0 },
  viewport: { width: 0, height: 0 },
  fitNonce: 0,
  showAnnotations: true,
  showConfidence: true,
  searching: false,
  event: null,

  load: async (projectId) => {
    set({ loading: true, error: null });
    try {
      const [project, images, annotations, models] = await Promise.all([
        getProject(projectId),
        listImages(projectId),
        listAnnotations(projectId),
        listModels(projectId),
      ]);
      if (!project) throw new Error('Project not found');
      const grouped: Record<string, Annotation[]> = {};
      for (const annotation of annotations) {
        (grouped[annotation.imageId] ??= []).push(annotation);
      }
      const preferred = images.find((image) => image.annotationCount === 0) ?? images[0];
      set({
        project,
        images,
        annotations: grouped,
        model: models[0] ?? null,
        activeClassId: project.classes[0]?.id ?? null,
        selectedImageId: preferred?.id ?? null,
        selectedAnnotationId: null,
        loading: false,
        zoom: 1,
        pan: { x: 0, y: 0 },
        predictions: {},
        histories: {},
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  unload: () => {
    activeJob?.cancel();
    activeJob = null;
    set({
      project: null,
      images: [],
      annotations: {},
      histories: {},
      predictions: {},
      model: null,
      selectedImageId: null,
      selectedAnnotationId: null,
      training: null,
      batch: null,
      error: null,
    });
  },

  selectImage: (imageId) => {
    const { images } = get();
    const index = images.findIndex((image) => image.id === imageId);
    set({
      selectedImageId: imageId,
      selectedAnnotationId: null,
      zoom: 1,
      pan: { x: 0, y: 0 },
      event: {
        id: ++eventSequence,
        kind: 'image',
        imageName: images[index]?.name,
        imageIndex: index + 1,
        imageTotal: images.length,
      },
    });
  },

  setTool: (tool) => set({ tool }),
  setActiveClass: (classId) => set({ activeClassId: classId, tool: get().tool === 'select' ? 'box' : get().tool }),
  selectAnnotation: (annotationId) => {
    const { annotations, selectedImageId } = get();
    const annotation = annotationId ? annotations[selectedImageId ?? '']?.find((a) => a.id === annotationId) : null;
    set({
      selectedAnnotationId: annotationId,
      event: annotation
        ? {
            id: ++eventSequence,
            kind: 'selected',
            classId: annotation.classId,
            annotationKind: annotation.geometry.kind,
          }
        : null,
    });
  },
  setZoom: (zoom) => {
    const { zoom: current, pan, viewport } = get();
    const next = Math.min(16, Math.max(0.05, zoom));
    if (next === current) return;
    const ratio = next / current;
    const cx = viewport.width / 2;
    const cy = viewport.height / 2;
    set({
      zoom: next,
      pan: { x: cx - (cx - pan.x) * ratio, y: cy - (cy - pan.y) * ratio },
    });
  },
  setPan: (pan) => set({ pan }),
  setViewport: (width, height) => set({ viewport: { width, height } }),
  requestFit: () => set({ fitNonce: get().fitNonce + 1 }),
  setShowAnnotations: (showAnnotations) => set({ showAnnotations }),
  setShowConfidence: (showConfidence) => set({ showConfidence }),

  beginEdit: (imageId) => {
    set((state) => ({ histories: { ...state.histories, [imageId]: pushHistory(state, imageId) } }));
  },

  setLocalAnnotations: (imageId, annotations) => {
    set((state) => ({ annotations: { ...state.annotations, [imageId]: annotations } }));
  },

  addAnnotation: (geometry, options = {}) => {
    const { project, selectedImageId, activeClassId, annotations } = get();
    if (!project || !selectedImageId) return null;
    const classId = options.classId ?? activeClassId ?? project.classes[0]?.id;
    if (!classId) return null;
    const timestamp = now();
    const annotation: Annotation = {
      id: uid('ann'),
      projectId: project.id,
      imageId: selectedImageId,
      classId,
      geometry,
      attributes: {},
      source: options.source ?? 'human',
      confidence: options.confidence,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const next = [...(annotations[selectedImageId] ?? []), annotation];
    set((state) => ({
      histories: { ...state.histories, [selectedImageId]: pushHistory(state, selectedImageId) },
      annotations: { ...state.annotations, [selectedImageId]: next },
      images: withAnnotationCount(state.images, selectedImageId, next.length),
      selectedAnnotationId: annotation.id,
      event: {
        id: ++eventSequence,
        kind: 'added',
        classId,
        annotationKind: geometry.kind,
        count: next.length,
      },
    }));
    void putAnnotations([annotation]);
    return annotation;
  },

  updateAnnotation: (annotationId, geometry, options = {}) => {
    const { annotations, selectedImageId } = get();
    if (!selectedImageId) return;
    const list = annotations[selectedImageId] ?? [];
    const next = list.map((annotation) =>
      annotation.id === annotationId ? { ...annotation, geometry, updatedAt: now() } : annotation,
    );
    set((state) => ({
      annotations: { ...state.annotations, [selectedImageId]: next },
      event: { id: ++eventSequence, kind: 'updated' },
    }));
    if (options.commit !== false) {
      const updated = next.find((annotation) => annotation.id === annotationId);
      if (updated) void putAnnotations([updated]);
    }
  },

  commitAnnotations: async (imageId) => {
    const list = get().annotations[imageId] ?? [];
    await replaceImageAnnotations(imageId, list);
  },

  deleteAnnotation: async (annotationId) => {
    const { annotations, selectedImageId } = get();
    if (!selectedImageId) return;
    const list = annotations[selectedImageId] ?? [];
    const target = list.find((annotation) => annotation.id === annotationId);
    if (!target) return;
    const next = list.filter((annotation) => annotation.id !== annotationId);
    set((state) => ({
      histories: { ...state.histories, [selectedImageId]: pushHistory(state, selectedImageId) },
      annotations: { ...state.annotations, [selectedImageId]: next },
      images: withAnnotationCount(state.images, selectedImageId, next.length),
      selectedAnnotationId: null,
      event: { id: ++eventSequence, kind: 'deleted', count: next.length },
    }));
    await deleteAnnotations([annotationId]);
  },

  duplicateAnnotation: (annotationId) => {
    const { annotations, selectedImageId } = get();
    if (!selectedImageId) return;
    const source = (annotations[selectedImageId] ?? []).find((annotation) => annotation.id === annotationId);
    if (!source) return;
    const offset = source.geometry.kind === 'bbox' ? 12 : 6;
    const moved =
      source.geometry.kind === 'bbox'
        ? { ...source.geometry, x: source.geometry.x + offset, y: source.geometry.y + offset }
        : { ...source.geometry, points: source.geometry.points.map((p) => ({ x: p.x + offset, y: p.y + offset })) };
    get().addAnnotation(moved, { classId: source.classId });
  },

  undo: async () => {
    const { selectedImageId, histories, annotations } = get();
    if (!selectedImageId) return;
    const history = histories[selectedImageId];
    if (!history || history.past.length === 0) return;
    const previous = history.past[history.past.length - 1];
    const current = cloneAnnotations(annotations[selectedImageId] ?? []);
    set((state) => ({
      annotations: { ...state.annotations, [selectedImageId]: previous },
      images: withAnnotationCount(state.images, selectedImageId, previous.length),
      histories: {
        ...state.histories,
        [selectedImageId]: { past: history.past.slice(0, -1), future: [current, ...history.future].slice(0, 50) },
      },
      selectedAnnotationId: null,
      event: { id: ++eventSequence, kind: 'undo' },
    }));
    await replaceImageAnnotations(selectedImageId, previous);
  },

  redo: async () => {
    const { selectedImageId, histories, annotations } = get();
    if (!selectedImageId) return;
    const history = histories[selectedImageId];
    if (!history || history.future.length === 0) return;
    const next = history.future[0];
    const current = cloneAnnotations(annotations[selectedImageId] ?? []);
    set((state) => ({
      annotations: { ...state.annotations, [selectedImageId]: next },
      images: withAnnotationCount(state.images, selectedImageId, next.length),
      histories: {
        ...state.histories,
        [selectedImageId]: { past: [...history.past, current], future: history.future.slice(1) },
      },
      selectedAnnotationId: null,
      event: { id: ++eventSequence, kind: 'redo' },
    }));
    await replaceImageAnnotations(selectedImageId, next);
  },

  addClass: async (name, keypoints) => {
    const { project } = get();
    if (!project) return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    const colorPool = ['#f97316', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#ec4899', '#14b8a6', '#ef4444'];
    const cls: ClassDef = {
      id: uid('cls'),
      name: trimmed,
      color: colorPool[project.classes.length % colorPool.length],
      keypoints: keypoints?.filter(Boolean),
    };
    const next = await saveProject({ ...project, classes: [...project.classes, cls] });
    set({ project: next, activeClassId: cls.id });
    return cls;
  },

  updateClass: async (classId, patch) => {
    const { project } = get();
    if (!project) return;
    const next = await saveProject({
      ...project,
      classes: project.classes.map((cls) => (cls.id === classId ? { ...cls, ...patch, id: classId } : cls)),
    });
    set({ project: next });
  },

  deleteClass: async (classId) => {
    const { project, images, annotations } = get();
    if (!project) return;
    const doomed = Object.values(annotations)
      .flat()
      .filter((annotation) => annotation.classId === classId)
      .map((annotation) => annotation.id);
    const nextProject = await saveProject({
      ...project,
      classes: project.classes.filter((cls) => cls.id !== classId),
    });
    if (doomed.length) await deleteAnnotations(doomed);
    const nextAnnotations: Record<string, Annotation[]> = {};
    let nextImages = images;
    for (const [imageId, list] of Object.entries(annotations)) {
      const filtered = list.filter((annotation) => annotation.classId !== classId);
      nextAnnotations[imageId] = filtered;
      if (filtered.length !== list.length) nextImages = withAnnotationCount(nextImages, imageId, filtered.length);
    }
    set({
      project: nextProject,
      annotations: nextAnnotations,
      images: nextImages,
      activeClassId: nextProject.classes[0]?.id ?? null,
      selectedAnnotationId: null,
    });
  },

  importImages: async (files) => {
    const { project, images } = get();
    if (!project) return null;
    try {
      const known = new Set(images.map((image) => image.hash).filter(Boolean));
      const expanded: File[] = [];
      for (const file of files) {
        if (file.type === 'application/zip' || file.name.toLowerCase().endsWith('.zip')) {
          expanded.push(...(await filesFromZip(file)));
        } else {
          expanded.push(file);
        }
      }
      const result = await importFiles(project.id, expanded, { knownHashes: known });
      const nextImages = await listImages(project.id);
      set({
        images: nextImages,
        selectedImageId: result.added[0]?.id ?? get().selectedImageId,
        event: result.added.length
          ? { id: ++eventSequence, kind: 'image', imageName: result.added[0].name, imageIndex: 1, imageTotal: nextImages.length }
          : get().event,
      });
      return result;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },

  refreshImages: async () => {
    const project = get().project;
    if (!project) return;
    set({ images: await listImages(project.id) });
  },

  setSplit: async (imageId, split) => {
    const { images } = get();
    const image = images.find((item) => item.id === imageId);
    if (!image) return;
    const next = { ...image, split };
    set({ images: images.map((item) => (item.id === imageId ? next : item)) });
    await saveImageMeta(next);
  },

  setTags: async (imageId, tags) => {
    const { images } = get();
    const image = images.find((item) => item.id === imageId);
    if (!image) return;
    const next = { ...image, tags };
    set({ images: images.map((item) => (item.id === imageId ? next : item)) });
    await saveImageMeta(next);
  },

  setNote: async (imageId, note) => {
    const { images } = get();
    const image = images.find((item) => item.id === imageId);
    if (!image) return;
    const next = { ...image, note };
    set({ images: images.map((item) => (item.id === imageId ? next : item)) });
    await saveImageMeta(next);
  },

  updateAutoLabel: async (patch) => {
    const { project } = get();
    if (!project) return;
    const next = await saveProject({ ...project, autoLabel: { ...project.autoLabel, ...patch } });
    set({ project: next });
  },

  trainModel: async (options = {}) => {
    const { project, images, annotations } = get();
    if (!project) return;
    const annotated = images.filter((image) => (annotations[image.id] ?? []).length > 0).slice(0, 300);
    if (annotated.length === 0) {
      set({ error: 'Annotate at least one image before training.' });
      return;
    }
    const humanAnnotations = Object.values(annotations)
      .flat()
      .filter((annotation) => annotation.source !== 'auto' || annotation.confidence !== undefined);
    const total = humanAnnotations.length;
    if (!options.force && total < project.autoLabel.minAnnotations) {
      set({ error: `Add ${project.autoLabel.minAnnotations - total} more annotations to train.` });
      return;
    }
    set({ training: { active: true, progress: 0, message: 'Preparing', stage: 'features' }, error: null });
    try {
      const payloadImages = [];
      for (const image of annotated) {
        const blob = await getImageBlob(image.id);
        if (blob) {
          payloadImages.push({ id: image.id, name: image.name, width: image.width, height: image.height, blob });
        }
      }
      const job = autoLabelClient.train(
        {
          projectId: project.id,
          projectType: project.type,
          classes: project.classes,
          annotations: humanAnnotations,
          settings: project.autoLabel,
          images: payloadImages,
        },
        (progress) => set({ training: busyFromProgress(progress) }),
      );
      activeJob = job as JobHandle<unknown>;
      const model = await job.promise;
      await saveModel(model);
      set({
        model,
        training: null,
        error: null,
        event: { id: ++eventSequence, kind: 'updated' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ training: null, error: message.includes('Cancelled') ? null : message });
    } finally {
      activeJob = null;
    }
  },

  predictImage: async (imageId) => {
    const { project, images, model, selectedImageId } = get();
    const targetId = imageId ?? selectedImageId;
    if (!project || !model || !targetId) return;
    const image = images.find((item) => item.id === targetId);
    if (!image) return;
    const blob = await getImageBlob(image.id);
    if (!blob) return;
    set({ batch: { active: true, progress: 0, message: image.name, stage: 'predicting' } });
    try {
      const job = autoLabelClient.predict(
        {
          model,
          settings: project.autoLabel,
          images: [{ id: image.id, name: image.name, width: image.width, height: image.height, blob }],
        },
        (progress) => set({ batch: busyFromProgress(progress) }),
      );
      activeJob = job as JobHandle<unknown>;
      const results = await job.promise;
      const nextPredictions = { ...get().predictions };
      for (const result of results) nextPredictions[result.imageId] = result.predictions;
      set({ predictions: nextPredictions, batch: null });
    } catch (error) {
      set({ batch: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      activeJob = null;
    }
  },

  predictUnlabeled: async (options = {}) => {
    const { project, images, annotations, model } = get();
    if (!project || !model) return;
    const targets = images.filter((image) => (annotations[image.id] ?? []).length === 0);
    if (targets.length === 0) return;
    set({ batch: { active: true, progress: 0, message: 'Preparing images', stage: 'predicting' }, error: null });
    try {
      const payloadImages = [];
      for (const image of targets) {
        const blob = await getImageBlob(image.id);
        if (blob) payloadImages.push({ id: image.id, name: image.name, width: image.width, height: image.height, blob });
      }
      const job = autoLabelClient.predict(
        { model, settings: project.autoLabel, images: payloadImages },
        (progress) => set({ batch: busyFromProgress(progress) }),
      );
      activeJob = job as JobHandle<unknown>;
      const results = await job.promise;
      if (options.autoAccept) {
        const accepted: Annotation[] = [];
        for (const result of results) {
          for (const prediction of result.predictions) {
            accepted.push(toAnnotation(project.id, result.imageId, prediction));
          }
        }
        const byImage = new Map<string, Annotation[]>();
        for (const annotation of accepted) {
          const list = byImage.get(annotation.imageId) ?? [];
          list.push(annotation);
          byImage.set(annotation.imageId, list);
        }
        for (const [imageId, list] of byImage) {
          await replaceImageAnnotations(imageId, [...(get().annotations[imageId] ?? []), ...list]);
        }
        const nextImages = await listImages(project.id);
        const nextAnnotations = { ...get().annotations };
        for (const [imageId, list] of byImage) {
          nextAnnotations[imageId] = [...(nextAnnotations[imageId] ?? []), ...list];
        }
        set({ batch: null, images: nextImages, annotations: nextAnnotations });
      } else {
        const nextPredictions = { ...get().predictions };
        for (const result of results) nextPredictions[result.imageId] = result.predictions;
        set({ predictions: nextPredictions, batch: null });
      }
    } catch (error) {
      set({ batch: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      activeJob = null;
    }
  },

  acceptPrediction: async (imageId, index) => {
    const { project, predictions, annotations } = get();
    if (!project) return;
    const list = predictions[imageId] ?? [];
    const prediction = list[index];
    if (!prediction) return;
    const annotation = toAnnotation(project.id, imageId, prediction);
    const nextImageAnnotations = [...(annotations[imageId] ?? []), annotation];
    await replaceImageAnnotations(imageId, nextImageAnnotations);
    set((state) => ({
      annotations: { ...state.annotations, [imageId]: nextImageAnnotations },
      images: withAnnotationCount(state.images, imageId, nextImageAnnotations.length),
      predictions: { ...state.predictions, [imageId]: list.filter((_, i) => i !== index) },
    }));
  },

  acceptAllPredictions: async (imageId) => {
    const { project, predictions, annotations } = get();
    if (!project) return;
    const list = predictions[imageId] ?? [];
    if (list.length === 0) return;
    const created = list.map((prediction) => toAnnotation(project.id, imageId, prediction));
    const nextImageAnnotations = [...(annotations[imageId] ?? []), ...created];
    await replaceImageAnnotations(imageId, nextImageAnnotations);
    set((state) => ({
      annotations: { ...state.annotations, [imageId]: nextImageAnnotations },
      images: withAnnotationCount(state.images, imageId, nextImageAnnotations.length),
      predictions: { ...state.predictions, [imageId]: [] },
    }));
  },

  discardPredictions: async (imageId) => {
    set((state) => ({ predictions: { ...state.predictions, [imageId]: [] } }));
  },

  cancelJob: () => {
    activeJob?.cancel();
    activeJob = null;
    set({ training: null, batch: null });
  },
}));

/** The current image's annotations, or an empty list. */
export function useCurrentAnnotations(): Annotation[] {
  return useStudio((state) => (state.selectedImageId ? state.annotations[state.selectedImageId] ?? [] : []));
}
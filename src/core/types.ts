/**
 * Domain model for OpenLabel.
 *
 * All geometry is stored in *source image pixel space* (origin top-left), which
 * makes exports resolution-independent and lets the canvas render at any zoom.
 */

export type ProjectType =
  | 'object-detection'
  | 'instance-segmentation'
  | 'keypoint'
  | 'classification';

export type SplitName = 'train' | 'valid' | 'test';

export interface Point {
  x: number;
  y: number;
}

export interface BBoxGeometry {
  kind: 'bbox';
  /** Top-left corner in image pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PolygonGeometry {
  kind: 'polygon';
  /** Closed polygon; the closing edge is implicit. */
  points: Point[];
}

export interface KeypointGeometry {
  kind: 'keypoints';
  /** One point per entry of the class skeleton, same order. */
  points: Point[];
}

export interface PolylineGeometry {
  kind: 'polyline';
  points: Point[];
}

export type Geometry = BBoxGeometry | PolygonGeometry | KeypointGeometry | PolylineGeometry;

export interface ClassDef {
  id: string;
  name: string;
  /** Hex color used for canvas strokes and chips. */
  color: string;
  /** Ordered skeleton labels for keypoint projects. */
  keypoints?: string[];
}

export interface Project {
  id: string;
  name: string;
  type: ProjectType;
  description: string;
  classes: ClassDef[];
  createdAt: number;
  updatedAt: number;
  /** Split fractions in percent; the three values must sum to 100. */
  split: Record<SplitName, number>;
  autoLabel: AutoLabelSettings;
  /** Images are ingested into a batch during an upload session. */
  archived?: boolean;
}

export interface AutoLabelSettings {
  /** Annotations required before training unlocks (Roboflow-style gate). */
  minAnnotations: number;
  /** Score threshold applied to previews and batch runs. */
  confidence: number;
  /** Maximum detections kept per image. */
  maxPerImage: number;
  /** IoU used by non-maximum suppression. */
  nmsIou: number;
  /** Blend template-similarity into the learned score (0 disables). */
  templateWeight: number;
}

export const DEFAULT_AUTO_LABEL: AutoLabelSettings = {
  minAnnotations: 10,
  confidence: 0.55,
  maxPerImage: 25,
  nmsIou: 0.45,
  templateWeight: 0.35,
};

export type AnnotationSource = 'human' | 'auto' | 'import';

export interface Annotation {
  id: string;
  projectId: string;
  imageId: string;
  classId: string;
  geometry: Geometry;
  attributes: Record<string, string>;
  source: AnnotationSource;
  /** Populated for auto-label predictions that were accepted. */
  confidence?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ImageMeta {
  id: string;
  projectId: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  mime: string;
  /** SHA-256 of the original bytes; used to skip re-imports. */
  hash: string;
  createdAt: number;
  tags: string[];
  batchId: string | null;
  /** Manual override; otherwise derived from the project split. */
  split: SplitName | null;
  /** 64-bit perceptual hash, hex encoded. Used for duplicate detection. */
  pHash: string;
  /**
   * Compact global descriptor (color layout + texture) used for image
   * similarity, split balancing and classification auto-labeling.
   */
  descriptor: number[];
  annotationCount: number;
  note: string;
}

export interface ImageBlob {
  id: string;
  blob: Blob;
  thumb: Blob;
}

export interface Batch {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  imageIds: string[];
}

export interface PreprocessConfig {
  resizeMode: 'none' | 'stretch' | 'fit';
  width: number;
  height: number;
  grayscale: boolean;
  autoOrient: boolean;
}

export interface AugmentationConfig {
  flipHorizontal: boolean;
  flipVertical: boolean;
  rotate90: boolean;
  brightness: number; // -1..1 multiplier delta
  contrast: number; // -1..1
  saturation: number;
  noise: number; // 0..1
  blur: number; // 0..10 px
  /** Number of augmented copies per source image; 0 disables. */
  copies: number;
}

export const DEFAULT_PREPROCESS: PreprocessConfig = {
  resizeMode: 'none',
  width: 640,
  height: 640,
  grayscale: false,
  autoOrient: true,
};

export const DEFAULT_AUGMENT: AugmentationConfig = {
  flipHorizontal: true,
  flipVertical: false,
  rotate90: false,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  noise: 0,
  blur: 0,
  copies: 2,
};

export interface DatasetVersion {
  id: string;
  projectId: string;
  name: string;
  number: number;
  createdAt: number;
  imageCount: number;
  annotationCount: number;
  classCounts: Record<string, number>;
  splitCounts: Record<SplitName, number>;
  /** Split fractions frozen with the version. */
  split: Record<SplitName, number>;
  preprocess: PreprocessConfig;
  augment: AugmentationConfig;
  /** Frozen membership, so later dataset edits never mutate a version. */
  imageIds: string[];
  notes: string;
}

/** Serialized few-shot model produced by the auto-label engine. */
export interface ModelBundle {
  id: string;
  projectId: string;
  createdAt: number;
  projectType: ProjectType;
  classes: { id: string; name: string; color: string }[];
  /** Number of human annotations used for training. */
  trainedOn: number;
  /** Window descriptor length (detection) or image descriptor length (classification). */
  dim: number;
  /** Softmax rows flattened: (classes + 1 background) x dim. */
  weights: number[];
  bias: number[];
  /** Proposal sizes learned from the annotated boxes, in working-image pixels. */
  anchors: { width: number; height: number }[];
  /** Mean positive descriptor per class, used for template blending. */
  templates: { classId: string; vector: number[] }[];
  /** Mean normalized keypoint layout per class (keypoint projects). */
  keypointPriors: { classId: string; points: number[][] }[];
  /** Mean global image descriptor per class (classification projects). */
  imageCentroids: { classId: string; vector: number[] }[];
  /** Operating point selected on held-out data. */
  threshold: number;
  /** Learned box-size correction (predicted boxes are systematically tight). */
  boxScale: { width: number; height: number };
  metrics: {
    precision: number;
    recall: number;
    f1: number;
    evaluated: number;
    threshold: number;
  };
  config: AutoLabelSettings;
  /** Opaque version tag so inference can reject incompatible weights. */
  formatVersion: number;
}

export interface Prediction {
  classId: string;
  geometry: Geometry;
  score: number;
}

export interface ShortcutBinding {
  action: string;
  keys: string;
}
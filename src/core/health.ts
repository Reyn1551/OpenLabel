/**
 * Dataset health diagnostics.
 *
 * The report is deliberately provider-agnostic: callers pass the images and
 * annotations they want inspected plus the split resolver already used by the
 * rest of the app. Everything is pure and synchronous, so the same report can
 * be rendered in a panel, written to a version, or asserted in a test.
 */

import { boxArea } from './geometry';
import { cosineSimilarity, hammingDistance } from './image';
import type { Annotation, ImageMeta, Project, SplitName } from './types';

/** Number of annotations of one class, together with display metadata. */
export interface ClassCount {
  classId: string;
  name: string;
  color: string;
  count: number;
}

/**
 * A cluster of images that look like the same scene.
 *
 * `distance` is the largest pairwise Hamming distance inside the cluster; a
 * value of 0 means the members have byte-identical perceptual hashes.
 */
export interface DuplicateGroup {
  imageIds: string[];
  distance: number;
}

/** One actionable finding, phrased for the dataset-health panel. */
export interface HealthIssue {
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  fix: string;
}

/** Complete, serializable health snapshot for one project. */
export interface HealthReport {
  imageCount: number;
  annotationCount: number;
  annotatedImages: number;
  unannotatedImages: number;
  classCounts: ClassCount[];
  /** Normalized entropy of class counts: 1 is perfectly balanced, 0 is absent. */
  balanceScore: number;
  duplicates: DuplicateGroup[];
  sizes: {
    minWidth: number;
    minHeight: number;
    maxWidth: number;
    maxHeight: number;
    medianWidth: number;
    medianHeight: number;
  };
  splitCounts: Record<'train' | 'valid' | 'test', number>;
  annotationsPerImage: {
    median: number;
    max: number;
    /** Index is an annotation count; the value is how many images have it. */
    histogram: number[];
  };
  /** Bounding boxes covering less than 1% of their image's area. */
  tinyBoxes: number;
  issues: HealthIssue[];
  recommendations: string[];
}

/** Hashes this close are treated as duplicates without descriptor evidence. */
const STRONG_DUPLICATE_HAMMING = 4;
/** Hashes this close may be duplicates when the descriptor also agrees. */
const WEAK_DUPLICATE_HAMMING = 10;
/** Descriptor cosine required for the weak-hash duplicate branch. */
const DUPLICATE_COSINE = 0.95;
/** Share of image area below which a box is reported as tiny. */
const TINY_BOX_FRACTION = 0.01;
/** Split proportions may drift this far from the project config before warning. */
const SPLIT_DRIFT_TOLERANCE = 0.2;
/** Relative weight of the visual descriptor in `findSimilarImages` scores. */
const SIMILARITY_DESCRIPTOR_WEIGHT = 0.7;

const SPLITS: readonly SplitName[] = ['train', 'valid', 'test'];

/** Median of an unsorted list; 0 for an empty list. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Normalized Shannon entropy of class counts.
 *
 * Zero-valued classes still count toward the denominator, so a project that
 * declares three classes but annotates only one scores 0. A single-class
 * project whose only class has annotations scores 1.
 */
function entropyBalance(counts: number[]): number {
  const total = counts.reduce((sum, count) => sum + Math.max(0, count), 0);
  if (total === 0) return 0;
  if (counts.length <= 1) return 1;
  let entropy = 0;
  for (const count of counts) {
    if (count <= 0) continue;
    const probability = count / total;
    entropy -= probability * Math.log(probability);
  }
  return Math.min(1, Math.max(0, entropy / Math.log(counts.length)));
}

function findRoot(parent: number[], index: number): number {
  let root = index;
  while (parent[root] !== root) root = parent[root];
  while (parent[index] !== root) {
    const next = parent[index];
    parent[index] = root;
    index = next;
  }
  return root;
}

function union(parent: number[], a: number, b: number): void {
  const rootA = findRoot(parent, a);
  const rootB = findRoot(parent, b);
  if (rootA !== rootB) parent[rootB] = rootA;
}

function areNearDuplicates(a: ImageMeta, b: ImageMeta): boolean {
  const distance = hammingDistance(a.pHash, b.pHash);
  if (distance <= STRONG_DUPLICATE_HAMMING) return true;
  if (distance > WEAK_DUPLICATE_HAMMING) return false;
  if (a.descriptor.length === 0 || b.descriptor.length === 0) return false;
  return cosineSimilarity(a.descriptor, b.descriptor) >= DUPLICATE_COSINE;
}

/**
 * Find groups of visually identical or near-identical images.
 *
 * A pair is a duplicate when its perceptual hashes are within 4 bits, or within
 * 10 bits while their global descriptors have a cosine similarity of at least
 * 0.95. Pairs are joined transitively, so a chain of close hashes forms one
 * group. Images without a perceptual hash are ignored because there is no
 * reliable identity signal to compare.
 *
 * @param images Images in any order; results preserve that order inside groups.
 * @returns Groups of two or more images, largest first, then by input order.
 */
export function detectDuplicates(images: ImageMeta[]): DuplicateGroup[] {
  const candidates = images.filter((image) => image.pHash.length > 0);
  if (candidates.length < 2) return [];

  const parent = candidates.map((_, index) => index);
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (areNearDuplicates(candidates[i], candidates[j])) union(parent, i, j);
    }
  }

  const groups = new Map<number, number[]>();
  candidates.forEach((_, index) => {
    const root = findRoot(parent, index);
    const members = groups.get(root);
    if (members) members.push(index);
    else groups.set(root, [index]);
  });

  const result: { imageIds: string[]; distance: number; order: number }[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    let distance = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        distance = Math.max(
          distance,
          hammingDistance(candidates[members[i]].pHash, candidates[members[j]].pHash),
        );
      }
    }
    result.push({
      imageIds: members.map((index) => candidates[index].id),
      distance,
      // Keep the earliest input index as the deterministic tie-breaker.
      order: members[0],
    });
  }

  result.sort((a, b) => {
    if (b.imageIds.length !== a.imageIds.length) return b.imageIds.length - a.imageIds.length;
    return a.order - b.order;
  });
  return result.map(({ imageIds, distance }) => ({ imageIds, distance }));
}

/**
 * Rank the images most similar to one reference image.
 *
 * Similarity blends the 92-dimension global descriptor (70%) with perceptual
 * hash agreement (30%), so color/layout and structure both matter. The
 * reference image itself is excluded.
 *
 * @param imageId Reference image id.
 * @param limit Maximum number of results; defaults to 5.
 * @returns Descending scores in `[0, 1]`, or `[]` when the id is unknown.
 */
export function findSimilarImages(
  images: ImageMeta[],
  imageId: string,
  limit = 5,
): { imageId: string; score: number }[] {
  const base = images.find((image) => image.id === imageId);
  if (!base) return [];
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 5;
  if (max === 0) return [];

  return images
    .filter((image) => image.id !== base.id)
    .map((image) => {
      const hashAgreement =
        base.pHash.length > 0 && image.pHash.length > 0
          ? 1 - hammingDistance(base.pHash, image.pHash) / 64
          : 0;
      const descriptorAgreement =
        base.descriptor.length > 0 && image.descriptor.length > 0
          ? Math.max(0, cosineSimilarity(base.descriptor, image.descriptor))
          : 0;
      const blended =
        SIMILARITY_DESCRIPTOR_WEIGHT * descriptorAgreement +
        (1 - SIMILARITY_DESCRIPTOR_WEIGHT) * hashAgreement;
      const score = Math.min(1, Math.max(0, blended));
      return { imageId: image.id, score };
    })
    .sort((a, b) => b.score - a.score || a.imageId.localeCompare(b.imageId))
    .slice(0, max);
}

function buildClassCounts(project: Project, annotations: Annotation[]): ClassCount[] {
  const counts = new Map<string, number>();
  for (const annotation of annotations) {
    counts.set(annotation.classId, (counts.get(annotation.classId) ?? 0) + 1);
  }
  const known = new Set(project.classes.map((cls) => cls.id));
  const classCounts: ClassCount[] = project.classes.map((cls) => ({
    classId: cls.id,
    name: cls.name,
    color: cls.color,
    count: counts.get(cls.id) ?? 0,
  }));
  // Annotations can outlive a deleted class during migration; surface them
  // rather than silently dropping the boxes from every total.
  const orphaned = [...counts.keys()].filter((classId) => !known.has(classId)).sort();
  for (const classId of orphaned) {
    classCounts.push({ classId, name: classId, color: '#64748b', count: counts.get(classId) ?? 0 });
  }
  return classCounts;
}

function buildIssues(input: {
  project: Project;
  imageCount: number;
  annotationCount: number;
  unannotatedImages: number;
  classCounts: ClassCount[];
  imagesByClass: Map<string, Set<string>>;
  balanceScore: number;
  duplicates: DuplicateGroup[];
  splitCounts: Record<SplitName, number>;
  tinyBoxes: number;
}): HealthIssue[] {
  const {
    project,
    imageCount,
    annotationCount,
    unannotatedImages,
    classCounts,
    imagesByClass,
    balanceScore,
    duplicates,
    splitCounts,
    tinyBoxes,
  } = input;
  const issues: HealthIssue[] = [];

  if (imageCount === 0) {
    issues.push({
      severity: 'error',
      title: 'No images in the project',
      detail: 'Dataset health cannot be measured until at least one image is available.',
      fix: 'Import images or generate the built-in demo dataset, then refresh this report.',
    });
  }

  if (project.classes.length === 0) {
    issues.push({
      severity: 'error',
      title: 'No classes defined',
      detail: 'Annotations cannot be created or evaluated without at least one class.',
      fix: 'Add a class in project settings before uploading or annotating images.',
    });
  }

  if (imageCount > 0 && annotationCount === 0) {
    issues.push({
      severity: 'warning',
      title: 'No annotations yet',
      detail: `${imageCount} image${imageCount === 1 ? '' : 's'} exist but no boxes or masks have been drawn.`,
      fix: `Draw at least ${project.autoLabel.minAnnotations} annotations, or run auto-labeling once a few examples exist.`,
    });
  } else if (unannotatedImages > 0) {
    issues.push({
      severity: unannotatedImages / imageCount >= 0.5 ? 'warning' : 'info',
      title: `${unannotatedImages} unannotated image${unannotatedImages === 1 ? '' : 's'}`,
      detail: `${unannotatedImages} of ${imageCount} images have no annotations and will train as pure background.`,
      fix: 'Auto-label the remaining images, or annotate them manually before creating a version.',
    });
  }

  if (annotationCount > 0 && classCounts.length > 1 && balanceScore < 0.6) {
    const used = classCounts.filter((cls) => cls.count > 0);
    const most = used.reduce((a, b) => (b.count > a.count ? b : a));
    const least = used.reduce((a, b) => (b.count < a.count ? b : a));
    const unused = classCounts.length - used.length;
    const detail =
      used.length === 1
        ? `All annotations belong to "${most.name}" while ${unused} declared class${unused === 1 ? '' : 'es'} have none.`
        : `Counts range from ${least.count} ("${least.name}") to ${most.count} ("${most.name}"); balance score is ${Math.round(balanceScore * 100)}%.`;
    issues.push({
      severity: balanceScore < 0.35 ? 'warning' : 'info',
      title: 'Class imbalance',
      detail,
      fix: `Collect or annotate more "${least.name}" examples, or remove classes the project does not need.`,
    });
  }

  if (imageCount > 1) {
    const sparse = classCounts.filter(
      (cls) => cls.count > 0 && (imagesByClass.get(cls.classId)?.size ?? 0) === 1,
    );
    if (sparse.length > 0) {
      const names = sparse.slice(0, 3).map((cls) => cls.name).join(', ');
      issues.push({
        severity: 'warning',
        title: `${sparse.length} class${sparse.length === 1 ? '' : 'es'} appear in only one image`,
        detail: `${names}${sparse.length > 3 ? `, and ${sparse.length - 3} more` : ''} have examples from a single image, so the model cannot learn their variation.`,
        fix: 'Annotate each class across at least two or three different images, or merge/remove redundant classes.',
      });
    }
  }

  if (duplicates.length > 0) {
    const duplicateImages = duplicates.reduce((sum, group) => sum + group.imageIds.length, 0);
    const largest = Math.max(...duplicates.map((group) => group.imageIds.length));
    issues.push({
      severity: 'warning',
      title: `${duplicates.length} near-duplicate group${duplicates.length === 1 ? '' : 's'} found`,
      detail: `${duplicateImages} images cluster into ${duplicates.length} group${duplicates.length === 1 ? '' : 's'}; the largest contains ${largest} images.`,
      fix: 'Delete duplicates, or keep every copy of a scene in one split so validation cannot leak into training.',
    });
  }

  if (tinyBoxes > 0) {
    issues.push({
      severity: 'warning',
      title: `${tinyBoxes} tiny annotation${tinyBoxes === 1 ? '' : 's'}`,
      detail: 'Boxes smaller than 1% of their image area are noisy targets that few detectors can learn.',
      fix: 'Delete accidental boxes or enlarge the drawn region; if the object really is tiny, crop and annotate at a higher resolution.',
    });
  }

  if (imageCount > 0) {
    const splitTotal = SPLITS.reduce((sum, split) => sum + project.split[split], 0);
    const emptyExpected = SPLITS.filter(
      (split) => project.split[split] > 0 && splitCounts[split] === 0,
    );
    if (emptyExpected.length > 0) {
      const labels = emptyExpected.map((split) => `"${split}"`).join(', ');
      issues.push({
        severity: 'warning',
        title: `${emptyExpected.length} split${emptyExpected.length === 1 ? '' : 's'} without images`,
        detail: `${labels} should receive images from the project split but received none.`,
        fix: 'Adjust the train/valid/test percentages or pin images to the empty split manually.',
      });
    }
    if (splitTotal > 0 && Math.abs(splitTotal - 100) > 0.5) {
      issues.push({
        severity: 'info',
        title: 'Split percentages do not sum to 100',
        detail: `The configured split totals ${splitTotal}%; assignments are normalized, but the stored configuration is ambiguous.`,
        fix: 'Edit the split percentages so train, valid, and test sum to exactly 100.',
      });
    }
    if (imageCount >= 10 && splitTotal > 0 && emptyExpected.length === 0) {
      const drifted = SPLITS.filter((split) => {
        const expected = project.split[split] / splitTotal;
        return Math.abs(splitCounts[split] / imageCount - expected) > SPLIT_DRIFT_TOLERANCE;
      });
      if (drifted.length > 0) {
        issues.push({
          severity: 'info',
          title: 'Split proportions drifted',
          detail: `${drifted.map((split) => `"${split}"`).join(', ')} differ from the configured percentages by more than ${SPLIT_DRIFT_TOLERANCE * 100}%.`,
          fix: 'Review manual split overrides or rebalance the split percentages before exporting a version.',
        });
      }
    }
    if (imageCount < 3) {
      issues.push({
        severity: 'info',
        title: 'Dataset too small for three splits',
        detail: `${imageCount} image${imageCount === 1 ? '' : 's'} cannot populate train, valid, and test meaningfully.`,
        fix: 'Add more images before creating a version with validation and test splits.',
      });
    }
  }

  return issues;
}

function buildRecommendations(input: {
  project: Project;
  imageCount: number;
  annotationCount: number;
  unannotatedImages: number;
  classCounts: ClassCount[];
  balanceScore: number;
  duplicates: DuplicateGroup[];
  splitCounts: Record<SplitName, number>;
  tinyBoxes: number;
}): string[] {
  const {
    project,
    imageCount,
    annotationCount,
    unannotatedImages,
    classCounts,
    balanceScore,
    duplicates,
    splitCounts,
    tinyBoxes,
  } = input;
  const recommendations: string[] = [];
  const add = (text: string): void => {
    if (!recommendations.includes(text)) recommendations.push(text);
  };

  if (imageCount === 0) {
    add('Import images or generate the built-in demo dataset, then refresh the health report.');
  }
  if (project.classes.length === 0) {
    add('Define at least one class before uploading or annotating images.');
  }
  if (imageCount > 0 && annotationCount === 0) {
    add(`Draw at least ${project.autoLabel.minAnnotations} examples to unlock auto-labeling.`);
  } else if (unannotatedImages > 0) {
    add(`Annotate or auto-label the ${unannotatedImages} remaining image${unannotatedImages === 1 ? '' : 's'}.`);
  }
  if (duplicates.length > 0) {
    add('Deduplicate near-identical scenes, or group each duplicate set into a single split.');
  }
  if (balanceScore < 0.7 && classCounts.length > 1 && annotationCount > 0) {
    const used = classCounts.filter((cls) => cls.count > 0);
    const rarest = used.length > 0 ? used.reduce((a, b) => (b.count < a.count ? b : a)) : undefined;
    add(
      rarest
        ? `Add more "${rarest.name}" examples to bring the balance score above 0.7.`
        : 'Add examples for every declared class to balance the dataset.',
    );
  }
  if (tinyBoxes > 0) {
    add('Remove or enlarge boxes smaller than 1% of the image area before exporting.');
  }
  const emptySplits = SPLITS.filter(
    (split) => project.split[split] > 0 && splitCounts[split] === 0,
  );
  if (emptySplits.length > 0) {
    add('Rebalance split percentages so train, valid, and test all receive images.');
  }
  if (Math.abs(SPLITS.reduce((sum, split) => sum + project.split[split], 0) - 100) > 0.5) {
    add('Edit the split percentages so train, valid, and test sum to exactly 100.');
  }
  if (imageCount > 0 && imageCount < 3) {
    add('Add more images before relying on validation and test splits.');
  }
  if (
    annotationCount > 0 &&
    annotationCount < project.autoLabel.minAnnotations &&
    imageCount > 0
  ) {
    add(`Collect at least ${project.autoLabel.minAnnotations} annotations to unlock few-shot auto-labeling.`);
  }
  if (recommendations.length === 0) {
    add('The dataset looks healthy. Export a version and train your first model.');
  }
  return recommendations;
}

/**
 * Build a complete health report for a project snapshot.
 *
 * @param project Project whose classes and split configuration are inspected.
 * @param images Images in scope. Annotations that reference other images still
 *   count toward class totals but are excluded from per-image metrics.
 * @param annotations Annotations in scope.
 * @param splitOf Resolves the effective split for an image (manual override or
 *   the same deterministic assignment used by version creation).
 */
export function buildHealthReport(
  project: Project,
  images: ImageMeta[],
  annotations: Annotation[],
  splitOf: (image: ImageMeta) => SplitName,
): HealthReport {
  const imageIds = new Set(images.map((image) => image.id));
  const imageById = new Map(images.map((image) => [image.id, image]));
  const classCounts = buildClassCounts(project, annotations);

  const imagesByClass = new Map<string, Set<string>>();
  const annotationsByImage = new Map<string, number>();
  for (const annotation of annotations) {
    annotationsByImage.set(annotation.imageId, (annotationsByImage.get(annotation.imageId) ?? 0) + 1);
    if (!imageIds.has(annotation.imageId)) continue;
    const members = imagesByClass.get(annotation.classId);
    if (members) members.add(annotation.imageId);
    else imagesByClass.set(annotation.classId, new Set([annotation.imageId]));
  }

  const annotatedIds = new Set<string>();
  for (const annotation of annotations) {
    if (imageIds.has(annotation.imageId)) annotatedIds.add(annotation.imageId);
  }

  const splitCounts: Record<SplitName, number> = { train: 0, valid: 0, test: 0 };
  for (const image of images) splitCounts[splitOf(image)] += 1;

  const perImageCounts = images.map((image) => annotationsByImage.get(image.id) ?? 0);
  const maxAnnotations = perImageCounts.length > 0 ? Math.max(...perImageCounts) : 0;
  const histogram = perImageCounts.length === 0 ? [] : new Array<number>(maxAnnotations + 1).fill(0);
  for (const count of perImageCounts) histogram[count] += 1;

  let tinyBoxes = 0;
  for (const annotation of annotations) {
    if (annotation.geometry.kind !== 'bbox') continue;
    const image = imageById.get(annotation.imageId);
    if (!image) continue;
    const imageArea = image.width * image.height;
    if (imageArea > 0 && boxArea(annotation.geometry) / imageArea < TINY_BOX_FRACTION) {
      tinyBoxes += 1;
    }
  }

  const widths = images.map((image) => image.width);
  const heights = images.map((image) => image.height);
  const balanceScore = entropyBalance(classCounts.map((cls) => cls.count));
  const duplicates = detectDuplicates(images);
  const annotatedImages = annotatedIds.size;
  const unannotatedImages = Math.max(0, images.length - annotatedImages);

  const issues = buildIssues({
    project,
    imageCount: images.length,
    annotationCount: annotations.length,
    unannotatedImages,
    classCounts,
    imagesByClass,
    balanceScore,
    duplicates,
    splitCounts,
    tinyBoxes,
  });

  return {
    imageCount: images.length,
    annotationCount: annotations.length,
    annotatedImages,
    unannotatedImages,
    classCounts,
    balanceScore,
    duplicates,
    sizes:
      images.length === 0
        ? {
            minWidth: 0,
            minHeight: 0,
            maxWidth: 0,
            maxHeight: 0,
            medianWidth: 0,
            medianHeight: 0,
          }
        : {
            minWidth: Math.min(...widths),
            minHeight: Math.min(...heights),
            maxWidth: Math.max(...widths),
            maxHeight: Math.max(...heights),
            medianWidth: median(widths),
            medianHeight: median(heights),
          },
    splitCounts,
    annotationsPerImage: { median: median(perImageCounts), max: maxAnnotations, histogram },
    tinyBoxes,
    issues,
    recommendations: buildRecommendations({
      project,
      imageCount: images.length,
      annotationCount: annotations.length,
      unannotatedImages,
      classCounts,
      balanceScore,
      duplicates,
      splitCounts,
      tinyBoxes,
    }),
  };
}
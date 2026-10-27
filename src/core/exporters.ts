/**
 * Dataset exporters.
 *
 * `buildExport` turns an in-memory project snapshot into a deterministic set of
 * text (and optionally image) files; `zipExport` packs them into a ZIP archive.
 *
 * All label coordinates are transformed from source image space through the
 * configured preprocessing and, for augmented variants, the configured geometric
 * augmentation. Photometric augmentation only touches pixels.
 */

import { strToU8, zipSync } from 'fflate';
import { bboxOfGeometry, clamp, polygonArea, round } from './geometry';
import type {
  Annotation,
  AugmentationConfig,
  BBoxGeometry,
  ClassDef,
  Geometry,
  ImageMeta,
  Point,
  PreprocessConfig,
  Project,
  SplitName,
} from './types';
import {
  augmentGeometry,
  preprocessLayout,
  renderAugmented,
  renderPreprocessed,
  transformGeometryForPreprocess,
} from './augment';

export { augmentGeometry, preprocessLayout, transformGeometryForPreprocess } from './augment';
export type { AugmentRender, GeometryAugment, PreprocessLayout, PreprocessedRender } from './augment';

export type ExportFormat = 'yolo' | 'yolo-seg' | 'coco' | 'voc' | 'csv' | 'openlabel';

export interface ExportInput {
  project: Project;
  images: ImageMeta[];
  annotations: Annotation[];
  splitOf: (image: ImageMeta) => SplitName;
  preprocess: PreprocessConfig;
  augment: AugmentationConfig;
  /** When true, preprocessed (and augmented) PNGs are written under `images/`. */
  includeImages: boolean;
  loadBlob: (imageId: string) => Promise<Blob | undefined>;
}

export interface ExportFile {
  path: string;
  data: Uint8Array | string;
}

export interface ExportResult {
  files: ExportFile[];
  warnings: string[];
}

/** One dataset entry: the original image or an augmented copy of it. */
interface Variant {
  image: ImageMeta;
  /** Sanitized, dataset-unique base name without extension. */
  name: string;
  split: SplitName;
  width: number;
  height: number;
  annotations: { annotation: Annotation; geometry: Geometry }[];
  /** 0 for the original, 1..n for augmented copies. */
  copy: number;
}

interface ClassLookup {
  byId: Map<string, ClassDef>;
  indexById: Map<string, number>;
  missing: Set<string>;
}

/** Fixed DOS-safe timestamp (1980-01-01 local) so ZIP bytes stay reproducible. */
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0).getTime();

/** Six decimals, as expected by YOLO tooling, without `-0.000000`. */
function fixed(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return (0).toFixed(digits);
  const safe = Math.abs(value) < 1e-9 ? 0 : value;
  return safe.toFixed(digits);
}

/** Trims trailing zeros from a rounded decimal. */
function shortNumber(value: number, digits = 2): string {
  const rounded = round(value, digits);
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** Strips the extension and makes a filesystem-safe, non-empty base name. */
function baseNameOf(name: string): string {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf('.');
  const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  const sanitized = stem
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .replace(/[_.]+$/, '');
  return sanitized || 'image';
}

/** Deterministically suffixes duplicates instead of overwriting files. */
function uniqueName(used: Set<string>, candidate: string): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let suffix = 2;
  while (used.has(`${candidate}_${suffix}`)) suffix += 1;
  const name = `${candidate}_${suffix}`;
  used.add(name);
  return name;
}

/** FNV-1a; stable per-image augmentation seeds across runs. */
function seedForVariant(variant: Variant): number {
  const value = `${variant.image.id}:${variant.copy}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function imagePath(variant: Variant): string {
  return `images/${variant.split}/${variant.name}.png`;
}

function classLookup(project: Project): ClassLookup {
  return {
    byId: new Map(project.classes.map((cls) => [cls.id, cls])),
    indexById: new Map(project.classes.map((cls, index) => [cls.id, index])),
    missing: new Set<string>(),
  };
}

function classFor(
  lookup: ClassLookup,
  annotation: Annotation,
  warnings: string[],
): ClassDef | undefined {
  const cls = lookup.byId.get(annotation.classId);
  if (cls) return cls;
  if (!lookup.missing.has(annotation.classId)) {
    lookup.missing.add(annotation.classId);
    warnings.push(`Annotation references unknown class "${annotation.classId}"; skipped.`);
  }
  return undefined;
}

/** Clips a geometry's bounding box to the frame. */
function frameBox(geometry: Geometry, width: number, height: number): BBoxGeometry {
  const raw = bboxOfGeometry(geometry);
  const left = clamp(raw.x, 0, width);
  const right = clamp(raw.x + raw.width, 0, width);
  const top = clamp(raw.y, 0, height);
  const bottom = clamp(raw.y + raw.height, 0, height);
  return {
    kind: 'bbox',
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function clampedPoints(points: Point[], width: number, height: number): Point[] {
  return points.map((point) => ({ x: clamp(point.x, 0, width), y: clamp(point.y, 0, height) }));
}

/** Rectangle polygon, clockwise from the top-left corner. */
function rectanglePoints(box: BBoxGeometry): Point[] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
}

/**
 * Plans one original and `augment.copies` augmented variants per image.
 *
 * Variant dimensions and annotation geometry are computed arithmetically, so
 * planning works without decoding any pixels.
 */
function planVariants(input: ExportInput, warnings: string[]): Variant[] {
  const annotationsByImage = new Map<string, Annotation[]>();
  for (const annotation of input.annotations) {
    const list = annotationsByImage.get(annotation.imageId);
    if (list) list.push(annotation);
    else annotationsByImage.set(annotation.imageId, [annotation]);
  }

  const copies = Math.max(0, Math.floor(input.augment.copies));
  const used = new Set<string>();
  const variants: Variant[] = [];

  for (const image of input.images) {
    if (image.width <= 0 || image.height <= 0) {
      warnings.push(`Image "${image.name}" has invalid dimensions; skipped.`);
      continue;
    }
    const split = input.splitOf(image);
    const layout = preprocessLayout(image.width, image.height, input.preprocess);
    const base = uniqueName(used, baseNameOf(image.name));
    const source = annotationsByImage.get(image.id) ?? [];
    const transformed = source.map((annotation) => ({
      annotation,
      geometry: transformGeometryForPreprocess(
        annotation.geometry,
        image.width,
        image.height,
        input.preprocess,
      ),
    }));
    variants.push({
      image,
      name: base,
      split,
      width: layout.width,
      height: layout.height,
      annotations: transformed,
      copy: 0,
    });

    if (copies === 0) continue;
    const frame = augmentGeometry(
      { kind: 'bbox', x: 0, y: 0, width: layout.width, height: layout.height },
      layout.width,
      layout.height,
      input.augment,
    );
    for (let copy = 1; copy <= copies; copy++) {
      const name = uniqueName(used, `${base}_aug${copy}`);
      variants.push({
        image,
        name,
        split,
        width: frame.width,
        height: frame.height,
        annotations: source.map((annotation) => {
          const preprocessed = transformGeometryForPreprocess(
            annotation.geometry,
            image.width,
            image.height,
            input.preprocess,
          );
          return {
            annotation,
            geometry: augmentGeometry(preprocessed, layout.width, layout.height, input.augment)
              .geometry,
          };
        }),
        copy,
      });
    }
  }

  return variants;
}

function buildYolo(
  variants: Variant[],
  project: Project,
  lookup: ClassLookup,
  warnings: string[],
  segmentation: boolean,
): ExportFile[] {
  const names = project.classes.map((cls) => `  - ${JSON.stringify(cls.name)}`);
  const yaml = [
    '# OpenLabel YOLO export',
    'train: images/train',
    'val: images/valid',
    'test: images/test',
    `nc: ${project.classes.length}`,
    'names:',
    ...(names.length ? names : ['  - "object"']),
    '',
  ].join('\n');
  const files: ExportFile[] = [{ path: 'data.yaml', data: yaml }];

  for (const variant of variants) {
    const lines: string[] = [];
    for (const { annotation, geometry } of variant.annotations) {
      const cls = classFor(lookup, annotation, warnings);
      if (!cls) continue;
      const index = lookup.indexById.get(cls.id) ?? 0;
      const line = segmentation
        ? yoloSegLine(index, geometry, variant, warnings)
        : yoloBoxLine(index, geometry, variant, warnings);
      if (line) lines.push(line);
    }
    files.push({
      path: `labels/${variant.split}/${variant.name}.txt`,
      data: lines.length ? `${lines.join('\n')}\n` : '',
    });
  }

  return files;
}

function yoloBoxLine(
  index: number,
  geometry: Geometry,
  variant: Variant,
  warnings: string[],
): string | null {
  const box = frameBox(geometry, variant.width, variant.height);
  if (box.width <= 0 || box.height <= 0) {
    warnings.push(`Skipped a zero-size box on "${variant.name}".`);
    return null;
  }
  const cx = clamp((box.x + box.width / 2) / variant.width, 0, 1);
  const cy = clamp((box.y + box.height / 2) / variant.height, 0, 1);
  const w = clamp(box.width / variant.width, 0, 1);
  const h = clamp(box.height / variant.height, 0, 1);
  return `${index} ${fixed(cx)} ${fixed(cy)} ${fixed(w)} ${fixed(h)}`;
}

function yoloSegLine(
  index: number,
  geometry: Geometry,
  variant: Variant,
  warnings: string[],
): string | null {
  let points: Point[];
  if (geometry.kind === 'polygon' && geometry.points.length >= 3) {
    points = clampedPoints(geometry.points, variant.width, variant.height);
  } else if (geometry.kind === 'bbox') {
    points = rectanglePoints(frameBox(geometry, variant.width, variant.height));
  } else {
    points = rectanglePoints(frameBox(geometry, variant.width, variant.height));
    warnings.push(
      `Converted ${geometry.kind} geometry to its bounding box for yolo-seg on "${variant.name}".`,
    );
  }
  if (points.length < 3) {
    warnings.push(`Skipped a degenerate polygon on "${variant.name}".`);
    return null;
  }
  const parts: string[] = [String(index)];
  for (const point of points) {
    parts.push(fixed(clamp(point.x / variant.width, 0, 1)));
    parts.push(fixed(clamp(point.y / variant.height, 0, 1)));
  }
  return parts.join(' ');
}

function buildCoco(
  variants: Variant[],
  project: Project,
  lookup: ClassLookup,
  warnings: string[],
): ExportFile[] {
  const categories = project.classes.map((cls, index) => ({
    id: index + 1,
    name: cls.name,
    supercategory: 'openlabel',
  }));
  const images: {
    id: number;
    file_name: string;
    width: number;
    height: number;
    license: number;
  }[] = [];
  const annotations: {
    id: number;
    image_id: number;
    category_id: number;
    bbox: [number, number, number, number];
    area: number;
    iscrowd: number;
    segmentation: number[][];
  }[] = [];
  let annotationId = 1;

  variants.forEach((variant, index) => {
    const imageId = index + 1;
    images.push({
      id: imageId,
      file_name: imagePath(variant),
      width: variant.width,
      height: variant.height,
      license: 0,
    });

    for (const { annotation, geometry } of variant.annotations) {
      const cls = classFor(lookup, annotation, warnings);
      if (!cls) continue;
      const categoryId = (lookup.indexById.get(cls.id) ?? 0) + 1;
      const box = frameBox(geometry, variant.width, variant.height);
      if (box.width <= 0 || box.height <= 0) {
        warnings.push(`Skipped a zero-size annotation on "${variant.name}".`);
        continue;
      }
      const area =
        geometry.kind === 'polygon'
          ? polygonArea(clampedPoints(geometry.points, variant.width, variant.height))
          : box.width * box.height;
      const points =
        geometry.kind === 'polygon'
          ? clampedPoints(geometry.points, variant.width, variant.height)
          : rectanglePoints(box);
      annotations.push({
        id: annotationId++,
        image_id: imageId,
        category_id: categoryId,
        bbox: [box.x, box.y, box.width, box.height],
        area,
        iscrowd: 0,
        segmentation: [points.flatMap((point) => [point.x, point.y])],
      });
    }
  });

  const createdAt = Number.isFinite(project.createdAt)
    ? new Date(project.createdAt).toISOString()
    : '1970-01-01T00:00:00.000Z';
  const document = {
    info: {
      description: project.name,
      url: '',
      version: '1.0',
      year: Number(createdAt.slice(0, 4)),
      contributor: 'OpenLabel',
      date_created: createdAt,
    },
    licenses: [],
    images,
    annotations,
    categories,
  };
  return [{ path: 'annotations/instances_default.json', data: `${JSON.stringify(document, null, 2)}\n` }];
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildVoc(
  variants: Variant[],
  lookup: ClassLookup,
  warnings: string[],
  grayscale: boolean,
): ExportFile[] {
  const files: ExportFile[] = [];
  const splitNames: Record<SplitName, string[]> = { train: [], valid: [], test: [] };

  for (const variant of variants) {
    splitNames[variant.split].push(variant.name);
    const objects: string[] = [];
    for (const { annotation, geometry } of variant.annotations) {
      const cls = classFor(lookup, annotation, warnings);
      if (!cls) continue;
      const box = frameBox(geometry, variant.width, variant.height);
      if (box.width <= 0 || box.height <= 0) {
        warnings.push(`Skipped a zero-size annotation on "${variant.name}".`);
        continue;
      }
      // Pascal VOC 2007 uses 1-based inclusive pixel coordinates.
      const xmin = clamp(Math.round(box.x) + 1, 1, variant.width);
      const ymin = clamp(Math.round(box.y) + 1, 1, variant.height);
      const xmax = clamp(Math.max(Math.round(box.x + box.width), xmin), 1, variant.width);
      const ymax = clamp(Math.max(Math.round(box.y + box.height), ymin), 1, variant.height);
      objects.push(
        [
          '  <object>',
          `    <name>${xmlEscape(cls.name)}</name>`,
          '    <pose>Unspecified</pose>',
          '    <truncated>0</truncated>',
          '    <difficult>0</difficult>',
          '    <bndbox>',
          `      <xmin>${xmin}</xmin>`,
          `      <ymin>${ymin}</ymin>`,
          `      <xmax>${xmax}</xmax>`,
          `      <ymax>${ymax}</ymax>`,
          '    </bndbox>',
          '  </object>',
        ].join('\n'),
      );
    }
    const depth = grayscale ? 1 : 3;
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<annotation>',
      `  <folder>${variant.split}</folder>`,
      `  <filename>${xmlEscape(`${variant.name}.png`)}</filename>`,
      `  <path>${xmlEscape(imagePath(variant))}</path>`,
      '  <source>',
      '    <database>OpenLabel</database>',
      '  </source>',
      '  <size>',
      `    <width>${variant.width}</width>`,
      `    <height>${variant.height}</height>`,
      `    <depth>${depth}</depth>`,
      '  </size>',
      '  <segmented>0</segmented>',
      ...objects,
      '</annotation>',
      '',
    ].join('\n');
    files.push({ path: `annotations/${variant.name}.xml`, data: xml });
  }

  for (const split of ['train', 'valid', 'test'] as const) {
    const setName = split === 'valid' ? 'val' : split;
    const names = splitNames[split];
    files.push({
      path: `ImageSets/Main/${setName}.txt`,
      data: names.length ? `${names.join('\n')}\n` : '',
    });
  }

  return files;
}

/**
 * Escapes one CSV cell.
 *
 * Cells that begin with a formula sigil are prefixed with an apostrophe so
 * Excel/LibreOffice treat them as text instead of executing them (CSV formula
 * injection); the rest is standard RFC 4180 quoting.
 */
function csvEscape(value: string): string {
  const neutralized = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

function buildCsv(variants: Variant[], lookup: ClassLookup, warnings: string[]): ExportFile[] {
  const header = [
    'image',
    'width',
    'height',
    'split',
    'class',
    'x_min',
    'y_min',
    'x_max',
    'y_max',
    'kind',
    'points',
    'confidence',
    'source',
  ];
  const rows: string[] = [header.join(',')];

  for (const variant of variants) {
    for (const { annotation, geometry } of variant.annotations) {
      const cls = classFor(lookup, annotation, warnings);
      if (!cls) continue;
      const box = frameBox(geometry, variant.width, variant.height);
      if (box.width <= 0 || box.height <= 0) {
        warnings.push(`Skipped a zero-size annotation on "${variant.name}".`);
        continue;
      }
      const points =
        geometry.kind === 'bbox'
          ? ''
          : clampedPoints(geometry.points, variant.width, variant.height)
              .map((point) => `${shortNumber(point.x)} ${shortNumber(point.y)}`)
              .join(';');
      rows.push(
        [
          csvEscape(imagePath(variant)),
          String(variant.width),
          String(variant.height),
          variant.split,
          csvEscape(cls.name),
          shortNumber(box.x),
          shortNumber(box.y),
          shortNumber(box.x + box.width),
          shortNumber(box.y + box.height),
          geometry.kind,
          csvEscape(points),
          annotation.confidence === undefined ? '' : shortNumber(annotation.confidence, 4),
          annotation.source,
        ].join(','),
      );
    }
  }

  return [{ path: 'annotations.csv', data: `${rows.join('\n')}\n` }];
}

function projectWithoutId(project: Project): Omit<Project, 'id'> {
  const copy: Omit<Project, 'id'> & { id?: string } = { ...project };
  delete copy.id;
  return copy;
}

function buildOpenLabel(input: ExportInput): ExportFile[] {
  const imageIds = new Set(input.images.map((image) => image.id));
  const splitOf = new Map<string, SplitName>();
  const splits: Record<SplitName, string[]> = { train: [], valid: [], test: [] };
  for (const image of input.images) {
    const split = input.splitOf(image);
    splitOf.set(image.id, split);
    splits[split].push(image.id);
  }
  const images = input.images.map((image) => ({ ...image, split: splitOf.get(image.id) ?? image.split }));
  const annotations = input.annotations.filter((annotation) => imageIds.has(annotation.imageId));

  const document = {
    format: 'openlabel',
    version: 1,
    project: projectWithoutId(input.project),
    classes: input.project.classes,
    images,
    annotations,
    splits,
  };

  const readme = [
    'OpenLabel portable dataset',
    '==========================',
    '',
    'dataset.json contains a lossless snapshot of the project:',
    '  - project: project settings without its local id',
    '  - classes: class definitions (id, name, color, keypoint skeleton)',
    '  - images: image metadata including widths, heights and assigned splits',
    '  - annotations: annotations in source image pixel space',
    '  - splits: image ids grouped by train / valid / test',
    '',
    'No binary image data is embedded. When exported with images enabled, the',
    'preprocessed PNGs are stored under images/<split>/<name>.png; geometry in',
    'dataset.json remains in source image pixels.',
    '',
  ].join('\n');

  return [
    { path: 'dataset.json', data: `${JSON.stringify(document, null, 2)}\n` },
    { path: 'README.txt', data: readme },
  ];
}

async function renderImageFiles(
  input: ExportInput,
  variants: Variant[],
  warnings: string[],
): Promise<ExportFile[]> {
  const byImage = new Map<string, Variant[]>();
  for (const variant of variants) {
    const list = byImage.get(variant.image.id);
    if (list) list.push(variant);
    else byImage.set(variant.image.id, [variant]);
  }

  const files: ExportFile[] = [];
  for (const image of input.images) {
    const imageVariants = byImage.get(image.id);
    if (!imageVariants || imageVariants.length === 0) continue;
    let blob: Blob | undefined;
    try {
      blob = await input.loadBlob(image.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to load image "${image.name}": ${reason}`);
      continue;
    }
    if (!blob) {
      warnings.push(`Image "${image.name}" has no stored data; image files skipped.`);
      continue;
    }
    for (const variant of imageVariants) {
      try {
        const rendered =
          variant.copy === 0
            ? await renderPreprocessed(blob, input.preprocess)
            : await renderAugmented(blob, input.augment, seedForVariant(variant), input.preprocess);
        files.push({
          path: imagePath(variant),
          data: new Uint8Array(await rendered.blob.arrayBuffer()),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const label = variant.copy === 0 ? '' : ` (aug ${variant.copy})`;
        warnings.push(`Failed to render image "${image.name}"${label}: ${reason}`);
      }
    }
  }
  return files;
}

/**
 * Builds an export for `format`.
 *
 * Augmented variants are planned even when `includeImages` is false: their label
 * files are part of the dataset. When `includeImages` is true, every variant is
 * written as a preprocessed PNG under `images/<split>/`.
 */
export async function buildExport(input: ExportInput, format: ExportFormat): Promise<ExportResult> {
  const warnings: string[] = [];
  const lookup = classLookup(input.project);
  const variants = planVariants(input, warnings);

  let files: ExportFile[];
  switch (format) {
    case 'yolo':
      files = buildYolo(variants, input.project, lookup, warnings, false);
      break;
    case 'yolo-seg':
      files = buildYolo(variants, input.project, lookup, warnings, true);
      break;
    case 'coco':
      files = buildCoco(variants, input.project, lookup, warnings);
      break;
    case 'voc':
      files = buildVoc(variants, lookup, warnings, input.preprocess.grayscale);
      break;
    case 'csv':
      files = buildCsv(variants, lookup, warnings);
      break;
    case 'openlabel':
      files = buildOpenLabel(input);
      break;
  }

  if (input.includeImages) {
    files.push(...(await renderImageFiles(input, variants, warnings)));
  }

  return { files, warnings };
}

/**
 * Packs export files into a ZIP with fixed entry timestamps.
 *
 * Identical inputs always produce byte-identical archives. String entries are
 * UTF-8 encoded.
 */
export async function zipExport(files: ExportFile[]): Promise<Blob> {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    entries[file.path] = typeof file.data === 'string' ? strToU8(file.data) : file.data;
  }
  const zipped = zipSync(entries, { level: 6, mtime: ZIP_MTIME });
  return new Blob([zipped], { type: 'application/zip' });
}
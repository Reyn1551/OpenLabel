import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
  augmentGeometry,
  buildExport,
  preprocessLayout,
  transformGeometryForPreprocess,
  zipExport,
  type ExportFile,
  type ExportInput,
} from '@/core/exporters';
import { DEFAULT_AUGMENT, DEFAULT_AUTO_LABEL, DEFAULT_PREPROCESS } from '@/core/types';
import type { Annotation, ImageMeta, Project, SplitName } from '@/core/types';

const project: Project = {
  id: 'prj_test',
  name: 'Export fixtures',
  type: 'instance-segmentation',
  description: 'Two images with a box and a polygon.',
  classes: [
    { id: 'cls_cat', name: 'cat', color: '#f97316' },
    { id: 'cls_dog', name: 'dog & <pal>', color: '#3b82f6' },
  ],
  createdAt: Date.UTC(2024, 4, 1),
  updatedAt: Date.UTC(2024, 4, 2),
  split: { train: 70, valid: 20, test: 10 },
  autoLabel: DEFAULT_AUTO_LABEL,
};

function makeImage(patch: Partial<ImageMeta> & Pick<ImageMeta, 'id' | 'name'>): ImageMeta {
  return {
    projectId: project.id,
    width: 200,
    height: 100,
    bytes: 1024,
    mime: 'image/jpeg',
    hash: 'sha256-fixture',
    createdAt: 1,
    tags: [],
    batchId: null,
    split: null,
    pHash: '0123456789abcdef',
    descriptor: [0.1, 0.2],
    annotationCount: 1,
    note: '',
    ...patch,
  };
}

const catImage = makeImage({ id: 'img_cat', name: 'cat.jpg', width: 200, height: 100 });
const dogImage = makeImage({ id: 'img_dog', name: 'dog.png', width: 100, height: 100 });

const images = [catImage, dogImage];

const catBox: Annotation = {
  id: 'ann_cat',
  projectId: project.id,
  imageId: catImage.id,
  classId: 'cls_cat',
  geometry: { kind: 'bbox', x: 20, y: 25, width: 60, height: 50 },
  attributes: {},
  source: 'human',
  createdAt: 1,
  updatedAt: 1,
};

const dogPolygon: Annotation = {
  id: 'ann_dog',
  projectId: project.id,
  imageId: dogImage.id,
  classId: 'cls_dog',
  geometry: {
    kind: 'polygon',
    points: [
      { x: 10, y: 10 },
      { x: 90, y: 10 },
      { x: 90, y: 90 },
      { x: 10, y: 90 },
    ],
  },
  attributes: {},
  source: 'auto',
  confidence: 0.9,
  createdAt: 2,
  updatedAt: 2,
};

const annotations = [catBox, dogPolygon];

const splitOf = (image: ImageMeta): SplitName => (image.id === dogImage.id ? 'test' : 'train');

function makeInput(patch: Partial<ExportInput> = {}): ExportInput {
  return {
    project,
    images,
    annotations,
    splitOf,
    preprocess: DEFAULT_PREPROCESS,
    augment: { ...DEFAULT_AUGMENT, copies: 0 },
    includeImages: false,
    loadBlob: async () => undefined,
    ...patch,
  };
}

function textFile(files: ExportFile[], path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Missing export file ${path}`);
  if (typeof file.data !== 'string') throw new Error(`File ${path} is binary`);
  return file.data;
}

function jsonFile<T>(files: ExportFile[], path: string): T {
  return JSON.parse(textFile(files, path)) as T;
}

/** jsdom's Blob predates `arrayBuffer()`; fall back to FileReader. */
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsArrayBuffer(blob);
  });
}

describe('YOLO export', () => {
  it('normalizes a known box', async () => {
    const { files } = await buildExport(makeInput(), 'yolo');
    expect(textFile(files, 'labels/train/cat.txt')).toBe(
      '0 0.250000 0.500000 0.300000 0.500000\n',
    );
    expect(textFile(files, 'labels/test/dog.txt')).toBe(
      '1 0.500000 0.500000 0.800000 0.800000\n',
    );
  });

  it('writes a data.yaml with class names, nc and split paths', async () => {
    const { files } = await buildExport(makeInput(), 'yolo');
    const yaml = textFile(files, 'data.yaml');
    expect(yaml).toContain('train: images/train');
    expect(yaml).toContain('val: images/valid');
    expect(yaml).toContain('test: images/test');
    expect(yaml).toContain('nc: 2');
    expect(yaml).toContain('  - "cat"');
    expect(yaml).toContain('  - "dog & <pal>"');
  });

  it('writes an empty label file when an image has no annotations', async () => {
    const { files } = await buildExport(makeInput({ annotations: [] }), 'yolo');
    expect(textFile(files, 'labels/train/cat.txt')).toBe('');
  });

  it('plans augmented variants without touching the original or loading images', async () => {
    const loadBlob = vi.fn(async () => {
      throw new Error('images must not be loaded when includeImages is false');
    });
    const augment = {
      ...DEFAULT_AUGMENT,
      copies: 2,
      flipHorizontal: true,
      flipVertical: false,
      rotate90: false,
      brightness: 0,
      contrast: 0,
      saturation: 0,
      noise: 0,
      blur: 0,
    };
    const { files } = await buildExport(makeInput({ augment, loadBlob }), 'yolo');
    expect(loadBlob).not.toHaveBeenCalled();
    expect(files.some((file) => file.path.startsWith('images/'))).toBe(false);
    expect(textFile(files, 'labels/train/cat.txt')).toBe(
      '0 0.250000 0.500000 0.300000 0.500000\n',
    );
    expect(textFile(files, 'labels/train/cat_aug1.txt')).toBe(
      '0 0.750000 0.500000 0.300000 0.500000\n',
    );
    expect(textFile(files, 'labels/train/cat_aug2.txt')).toBe(
      '0 0.750000 0.500000 0.300000 0.500000\n',
    );
  });

  it('reports unknown class references and skips them', async () => {
    const unknown: Annotation = { ...catBox, id: 'ann_unknown', classId: 'cls_missing' };
    const { files, warnings } = await buildExport(
      makeInput({ annotations: [unknown] }),
      'yolo',
    );
    expect(textFile(files, 'labels/train/cat.txt')).toBe('');
    expect(warnings.some((warning) => warning.includes('cls_missing'))).toBe(true);
  });
});

describe('YOLO segmentation export', () => {
  it('normalizes polygon points', async () => {
    const { files } = await buildExport(makeInput(), 'yolo-seg');
    expect(textFile(files, 'labels/test/dog.txt')).toBe(
      '1 0.100000 0.100000 0.900000 0.100000 0.900000 0.900000 0.100000 0.900000\n',
    );
  });

  it('expands a bbox into a four-corner polygon', async () => {
    const { files } = await buildExport(makeInput(), 'yolo-seg');
    expect(textFile(files, 'labels/train/cat.txt')).toBe(
      '0 0.100000 0.250000 0.400000 0.250000 0.400000 0.750000 0.100000 0.750000\n',
    );
  });
});

interface CocoDocument {
  info: { version: string; description: string };
  licenses: unknown[];
  images: { id: number; file_name: string; width: number; height: number }[];
  annotations: {
    id: number;
    image_id: number;
    category_id: number;
    bbox: number[];
    area: number;
    iscrowd: number;
    segmentation: number[][];
  }[];
  categories: { id: number; name: string; supercategory: string }[];
}

describe('COCO export', () => {
  it('produces COCO 1.0 structure with stable ids and areas', async () => {
    const { files } = await buildExport(makeInput(), 'coco');
    const coco = jsonFile<CocoDocument>(files, 'annotations/instances_default.json');

    expect(coco.info.version).toBe('1.0');
    expect(coco.licenses).toEqual([]);
    expect(coco.categories).toEqual([
      { id: 1, name: 'cat', supercategory: 'openlabel' },
      { id: 2, name: 'dog & <pal>', supercategory: 'openlabel' },
    ]);
    expect(coco.images).toEqual([
      { id: 1, file_name: 'images/train/cat.png', width: 200, height: 100, license: 0 },
      { id: 2, file_name: 'images/test/dog.png', width: 100, height: 100, license: 0 },
    ]);

    const box = coco.annotations[0];
    expect(box).toMatchObject({
      id: 1,
      image_id: 1,
      category_id: 1,
      bbox: [20, 25, 60, 50],
      area: 3000,
      iscrowd: 0,
    });
    expect(box.segmentation).toEqual([[20, 25, 80, 25, 80, 75, 20, 75]]);

    const polygon = coco.annotations[1];
    expect(polygon).toMatchObject({
      id: 2,
      image_id: 2,
      category_id: 2,
      bbox: [10, 10, 80, 80],
      area: 6400,
      iscrowd: 0,
    });
    expect(polygon.segmentation).toEqual([[10, 10, 90, 10, 90, 90, 10, 90]]);
  });

  it('reflects augmented variants as separate COCO images', async () => {
    const augment = { ...DEFAULT_AUGMENT, copies: 1, flipHorizontal: false };
    const { files } = await buildExport(makeInput({ augment }), 'coco');
    const coco = jsonFile<CocoDocument>(files, 'annotations/instances_default.json');
    expect(coco.images).toHaveLength(4);
    expect(coco.images[1].file_name).toBe('images/train/cat_aug1.png');
  });
});

describe('Pascal VOC export', () => {
  it('escapes XML text and writes 1-based inclusive boxes', async () => {
    const { files } = await buildExport(makeInput(), 'voc');
    const xml = textFile(files, 'annotations/dog.xml');
    expect(xml).toContain('<name>dog &amp; &lt;pal&gt;</name>');
    expect(xml).toContain('<folder>test</folder>');
    expect(xml).toContain('<filename>dog.png</filename>');
    expect(xml).toContain('<depth>3</depth>');
    expect(xml).toContain('<xmin>11</xmin>');
    expect(xml).toContain('<ymin>11</ymin>');
    expect(xml).toContain('<xmax>90</xmax>');
    expect(xml).toContain('<ymax>90</ymax>');
  });

  it('writes ImageSets lists for train, val and test', async () => {
    const { files } = await buildExport(makeInput(), 'voc');
    expect(textFile(files, 'ImageSets/Main/train.txt')).toBe('cat\n');
    expect(textFile(files, 'ImageSets/Main/val.txt')).toBe('');
    expect(textFile(files, 'ImageSets/Main/test.txt')).toBe('dog\n');
  });
});

describe('CSV export', () => {
  it('writes the documented columns and one row per annotation', async () => {
    const { files } = await buildExport(makeInput(), 'csv');
    const lines = textFile(files, 'annotations.csv').trimEnd().split('\n');
    expect(lines[0]).toBe(
      'image,width,height,split,class,x_min,y_min,x_max,y_max,kind,points,confidence,source',
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      'images/train/cat.png,200,100,train,cat,20,25,80,75,bbox,,,human',
    );
    expect(lines[2]).toBe(
      'images/test/dog.png,100,100,test,dog & <pal>,10,10,90,90,polygon,10 10;90 10;90 90;10 90,0.9,auto',
    );
  });

  it('neutralizes cells that look like spreadsheet formulas', async () => {
    const formulaProject: Project = {
      ...project,
      classes: [
        { id: 'cls_cat', name: '=1+1', color: '#f97316' },
        { id: 'cls_dog', name: '@SUM(A1)', color: '#3b82f6' },
      ],
    };
    const { files } = await buildExport(makeInput({ project: formulaProject }), 'csv');
    const lines = textFile(files, 'annotations.csv').trimEnd().split('\n');
    expect(lines[1]).toContain(",'=1+1,");
    expect(lines[2]).toContain(",'@SUM(A1),");
    expect(lines[1]).not.toContain(',=1+1,');
  });
});

interface OpenLabelDocument {
  format: string;
  version: number;
  project: Record<string, unknown>;
  classes: Project['classes'];
  images: (ImageMeta & { split: SplitName })[];
  annotations: Annotation[];
  splits: Record<SplitName, string[]>;
}

describe('OpenLabel export', () => {
  it('round-trips the project without ids or blobs', async () => {
    const { files } = await buildExport(makeInput(), 'openlabel');
    const document = jsonFile<OpenLabelDocument>(files, 'dataset.json');

    expect(document.format).toBe('openlabel');
    expect(document.version).toBe(1);
    expect(document.project).not.toHaveProperty('id');
    expect(document.project).toMatchObject({ name: project.name, type: project.type });
    expect(document.classes).toEqual(project.classes);
    expect(document.images).toHaveLength(2);
    expect(document.images[0]).toMatchObject({ id: 'img_cat', split: 'train' });
    expect(document.images[1]).toMatchObject({ id: 'img_dog', split: 'test' });
    expect(document.images.every((image) => !('blob' in image))).toBe(true);
    expect(document.annotations).toEqual(annotations);
    expect(document.splits).toEqual({ train: ['img_cat'], valid: [], test: ['img_dog'] });
    expect(textFile(files, 'README.txt')).toContain('OpenLabel portable dataset');
  });
});

describe('preprocessing geometry', () => {
  it('stretches geometry to the configured size', () => {
    const layout = preprocessLayout(200, 100, {
      ...DEFAULT_PREPROCESS,
      resizeMode: 'stretch',
      width: 640,
      height: 640,
    });
    expect(layout).toEqual({
      width: 640,
      height: 640,
      scaleX: 3.2,
      scaleY: 6.4,
      offsetX: 0,
      offsetY: 0,
    });
    expect(
      transformGeometryForPreprocess(catBox.geometry, 200, 100, {
        ...DEFAULT_PREPROCESS,
        resizeMode: 'stretch',
        width: 640,
        height: 640,
      }),
    ).toEqual({ kind: 'bbox', x: 64, y: 160, width: 192, height: 320 });
  });

  it('letterboxes geometry with a centered offset', () => {
    const preprocess = {
      ...DEFAULT_PREPROCESS,
      resizeMode: 'fit' as const,
      width: 640,
      height: 640,
    };
    expect(preprocessLayout(200, 100, preprocess)).toEqual({
      width: 640,
      height: 640,
      scaleX: 3.2,
      scaleY: 3.2,
      offsetX: 0,
      offsetY: 160,
    });
    expect(transformGeometryForPreprocess(catBox.geometry, 200, 100, preprocess)).toEqual({
      kind: 'bbox',
      x: 64,
      y: 240,
      width: 192,
      height: 160,
    });
  });

  it('clamps geometry into the frame', () => {
    const transformed = transformGeometryForPreprocess(
      { kind: 'bbox', x: 180, y: 10, width: 40, height: 200 },
      200,
      100,
      { ...DEFAULT_PREPROCESS, resizeMode: 'none' },
    );
    expect(transformed).toEqual({ kind: 'bbox', x: 180, y: 10, width: 20, height: 90 });
  });
});

describe('augmentation geometry', () => {
  const base = { ...DEFAULT_AUGMENT, copies: 1, flipHorizontal: false, flipVertical: false, rotate90: false };

  it('mirrors a box horizontally and vertically', () => {
    const horizontal = augmentGeometry(
      { kind: 'bbox', x: 10, y: 5, width: 20, height: 10 },
      100,
      50,
      { ...base, flipHorizontal: true },
    );
    expect(horizontal.geometry).toEqual({ kind: 'bbox', x: 70, y: 5, width: 20, height: 10 });

    const vertical = augmentGeometry(
      { kind: 'bbox', x: 10, y: 5, width: 20, height: 10 },
      100,
      50,
      { ...base, flipVertical: true },
    );
    expect(vertical.geometry).toEqual({ kind: 'bbox', x: 10, y: 35, width: 20, height: 10 });
  });

  it('rotates 90 degrees and swaps the frame dimensions', () => {
    const rotated = augmentGeometry(
      { kind: 'bbox', x: 10, y: 5, width: 20, height: 10 },
      100,
      50,
      { ...base, rotate90: true },
    );
    expect(rotated.width).toBe(50);
    expect(rotated.height).toBe(100);
    expect(rotated.geometry).toEqual({ kind: 'bbox', x: 35, y: 10, width: 10, height: 20 });
  });

  it('mirrors polygon points exactly', () => {
    const result = augmentGeometry(
      {
        kind: 'polygon',
        points: [
          { x: 10, y: 10 },
          { x: 90, y: 10 },
          { x: 50, y: 40 },
        ],
      },
      100,
      50,
      { ...base, flipHorizontal: true, flipVertical: true },
    );
    expect(result.geometry).toEqual({
      kind: 'polygon',
      points: [
        { x: 90, y: 40 },
        { x: 10, y: 40 },
        { x: 50, y: 10 },
      ],
    });
  });

  it('rotates labels along with the variant frame', async () => {
    const augment = { ...base, rotate90: true, flipHorizontal: false };
    const { files } = await buildExport(makeInput({ augment }), 'yolo');
    expect(textFile(files, 'labels/train/cat_aug1.txt')).toBe(
      '0 0.500000 0.250000 0.500000 0.300000\n',
    );
  });
});

describe('zipExport', () => {
  it('packs strings and bytes that unzip to identical data', async () => {
    const files: ExportFile[] = [
      { path: 'nested/notes.txt', data: 'hello Ünïcode\n' },
      { path: 'binary.bin', data: new Uint8Array([0, 1, 2, 255]) },
    ];
    const blob = await zipExport(files);
    expect(blob.type).toBe('application/zip');
    const entries = unzipSync(await blobBytes(blob));
    expect(Object.keys(entries).sort()).toEqual(['binary.bin', 'nested/notes.txt']);
    expect(strFromU8(entries['nested/notes.txt'])).toBe('hello Ünïcode\n');
    expect(Array.from(entries['binary.bin'])).toEqual([0, 1, 2, 255]);
  });

  it('is deterministic for identical input', async () => {
    const { files } = await buildExport(makeInput(), 'csv');
    const first = await blobBytes(await zipExport(files));
    const second = await blobBytes(await zipExport(files));
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it('round-trips a complete export', async () => {
    const { files } = await buildExport(makeInput(), 'voc');
    const entries = unzipSync(await blobBytes(await zipExport(files)));
    expect(Object.keys(entries).sort()).toEqual(
      ['ImageSets/Main/test.txt', 'ImageSets/Main/train.txt', 'ImageSets/Main/val.txt', 'annotations/cat.xml', 'annotations/dog.xml'].sort(),
    );
    expect(strFromU8(entries['annotations/cat.xml'])).toBe(textFile(files, 'annotations/cat.xml'));
  });
});
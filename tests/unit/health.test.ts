import { describe, expect, it } from 'vitest';
import { buildHealthReport, detectDuplicates, findSimilarImages } from '@/core/health';
import type { Annotation, ClassDef, ImageMeta, Project, SplitName } from '@/core/types';
import { DEFAULT_AUTO_LABEL } from '@/core/types';

const CLASSES: ClassDef[] = [
  { id: 'bolt', name: 'bolt', color: '#ef4444' },
  { id: 'gear', name: 'gear', color: '#22c55e' },
  { id: 'washer', name: 'washer', color: '#3b82f6' },
];

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Fixture project',
    type: 'object-detection',
    description: '',
    classes: CLASSES,
    createdAt: 0,
    updatedAt: 0,
    split: { train: 70, valid: 20, test: 10 },
    autoLabel: { ...DEFAULT_AUTO_LABEL },
    ...overrides,
  };
}

/** FNV-1a 64-bit, just to give every fixture a stable, well-separated hash. */
function fakeHash(seed: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const char of seed) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function makeImage(id: string, overrides: Partial<ImageMeta> = {}): ImageMeta {
  return {
    id,
    projectId: 'p1',
    name: `${id}.png`,
    width: 480,
    height: 360,
    bytes: 2048,
    mime: 'image/png',
    hash: fakeHash(`${id}:bytes`),
    createdAt: 0,
    tags: [],
    batchId: null,
    split: null,
    pHash: fakeHash(id),
    descriptor: [1, 0, 0, 0],
    annotationCount: 0,
    note: '',
    ...overrides,
  };
}

function makeAnnotation(
  id: string,
  imageId: string,
  classId: string,
  overrides: Partial<Annotation> = {},
): Annotation {
  return {
    id,
    projectId: 'p1',
    imageId,
    classId,
    geometry: { kind: 'bbox', x: 100, y: 100, width: 80, height: 60 },
    attributes: {},
    source: 'human',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const splitFromMeta = (image: ImageMeta): SplitName => image.split ?? 'train';

describe('buildHealthReport balance score', () => {
  it('scores perfectly balanced class counts as 1', () => {
    const images = [makeImage('i1'), makeImage('i2')];
    const annotations = [
      makeAnnotation('a1', 'i1', 'bolt'),
      makeAnnotation('a2', 'i1', 'gear'),
      makeAnnotation('a3', 'i1', 'washer'),
      makeAnnotation('a4', 'i2', 'bolt'),
      makeAnnotation('a5', 'i2', 'gear'),
      makeAnnotation('a6', 'i2', 'washer'),
    ];

    const report = buildHealthReport(makeProject(), images, annotations, splitFromMeta);

    expect(report.classCounts.map((cls) => cls.count)).toEqual([2, 2, 2]);
    expect(report.balanceScore).toBeCloseTo(1, 6);
    expect(report.issues.some((issue) => /class imbalance/i.test(issue.title))).toBe(false);
  });

  it('scores a dataset that only uses one declared class as 0', () => {
    const images = [makeImage('i1'), makeImage('i2')];
    const annotations = Array.from({ length: 10 }, (_, index) =>
      makeAnnotation(`a${index}`, index % 2 === 0 ? 'i1' : 'i2', 'bolt'),
    );

    const report = buildHealthReport(makeProject(), images, annotations, splitFromMeta);

    expect(report.balanceScore).toBe(0);
    expect(report.classCounts.map((cls) => cls.count)).toEqual([10, 0, 0]);
    expect(report.issues.some((issue) => /class imbalance/i.test(issue.title))).toBe(true);
  });

  it('scores an empty dataset as 0', () => {
    const report = buildHealthReport(makeProject(), [], [], splitFromMeta);
    expect(report.balanceScore).toBe(0);
  });

  it('treats a single-class project as balanced when that class is annotated', () => {
    const project = makeProject({ classes: [CLASSES[0]] });
    const images = [makeImage('i1'), makeImage('i2')];
    const annotations = [
      makeAnnotation('a1', 'i1', 'bolt'),
      makeAnnotation('a2', 'i2', 'bolt'),
    ];

    const report = buildHealthReport(project, images, annotations, splitFromMeta);

    expect(report.balanceScore).toBe(1);
  });
});

describe('detectDuplicates', () => {
  it('groups identical and near-identical hashes', () => {
    const images = [
      makeImage('a', { pHash: '0000000000000000', descriptor: [] }),
      makeImage('b', { pHash: '0000000000000000', descriptor: [] }),
      makeImage('c', { pHash: '0000000000000003', descriptor: [] }),
      makeImage('d', { pHash: 'ffffffffffffffff', descriptor: [] }),
    ];

    const groups = detectDuplicates(images);

    expect(groups).toHaveLength(1);
    expect(groups[0].imageIds).toEqual(['a', 'b', 'c']);
    expect(groups[0].distance).toBe(2);
  });

  it('requires descriptor agreement for weaker hash matches', () => {
    const shared = [0.9, 0.1, 0.2];
    const orthogonal = [0, 1, 0];

    const agree = detectDuplicates([
      makeImage('a', { pHash: '0000000000000000', descriptor: shared }),
      makeImage('b', { pHash: '00000000000000ff', descriptor: shared }),
    ]);
    expect(agree).toHaveLength(1);
    expect(agree[0].imageIds).toEqual(['a', 'b']);
    expect(agree[0].distance).toBe(8);

    const disagree = detectDuplicates([
      makeImage('a', { pHash: '0000000000000000', descriptor: shared }),
      makeImage('b', { pHash: '00000000000000ff', descriptor: orthogonal }),
    ]);
    expect(disagree).toEqual([]);
  });

  it('ignores images without a perceptual hash', () => {
    const images = [
      makeImage('a', { pHash: '', descriptor: [1, 0] }),
      makeImage('b', { pHash: '', descriptor: [1, 0] }),
    ];
    expect(detectDuplicates(images)).toEqual([]);
  });
});

describe('buildHealthReport split counts and per-image stats', () => {
  it('counts splits through the supplied resolver', () => {
    const images = [
      makeImage('i1', { split: 'train' }),
      makeImage('i2', { split: 'train' }),
      makeImage('i3', { split: 'valid' }),
      makeImage('i4', { split: 'test' }),
      makeImage('i5', { split: 'train' }),
    ];

    const report = buildHealthReport(makeProject(), images, [], splitFromMeta);

    expect(report.splitCounts).toEqual({ train: 3, valid: 1, test: 1 });
  });

  it('computes annotation histogram, medians, and image sizes', () => {
    const images = [
      makeImage('i1', { width: 480, height: 360 }),
      makeImage('i2', { width: 640, height: 480 }),
      makeImage('i3', { width: 320, height: 240 }),
    ];
    const annotations = [
      makeAnnotation('a1', 'i2', 'bolt'),
      makeAnnotation('a2', 'i2', 'gear'),
      makeAnnotation('a3', 'i3', 'bolt'),
      makeAnnotation('a4', 'i3', 'gear'),
    ];

    const report = buildHealthReport(makeProject(), images, annotations, splitFromMeta);

    expect(report.annotatedImages).toBe(2);
    expect(report.unannotatedImages).toBe(1);
    expect(report.annotationsPerImage).toEqual({ median: 2, max: 2, histogram: [1, 0, 2] });
    expect(report.sizes).toEqual({
      minWidth: 320,
      minHeight: 240,
      maxWidth: 640,
      maxHeight: 480,
      medianWidth: 480,
      medianHeight: 360,
    });
  });
});

describe('buildHealthReport issues', () => {
  it('reports an empty dataset with an actionable error', () => {
    const report = buildHealthReport(makeProject(), [], [], splitFromMeta);

    expect(report.imageCount).toBe(0);
    expect(report.annotationCount).toBe(0);
    expect(report.sizes).toEqual({
      minWidth: 0,
      minHeight: 0,
      maxWidth: 0,
      maxHeight: 0,
      medianWidth: 0,
      medianHeight: 0,
    });
    expect(report.annotationsPerImage).toEqual({ median: 0, max: 0, histogram: [] });

    const emptyIssue = report.issues.find((issue) => /no images/i.test(issue.title));
    expect(emptyIssue?.severity).toBe('error');
    expect(emptyIssue?.fix.length).toBeGreaterThan(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
  });

  it('reports class imbalance and one-image classes', () => {
    const images = [makeImage('i1'), makeImage('i2'), makeImage('i3')];
    const annotations = [
      ...Array.from({ length: 8 }, (_, index) => makeAnnotation(`b${index}`, 'i1', 'bolt')),
      makeAnnotation('g1', 'i2', 'gear'),
    ];

    const report = buildHealthReport(makeProject(), images, annotations, splitFromMeta);

    expect(report.balanceScore).toBeLessThan(0.6);
    expect(report.issues.some((issue) => /class imbalance/i.test(issue.title))).toBe(true);
    expect(report.issues.some((issue) => /only one image/i.test(issue.title))).toBe(true);
    expect(report.recommendations.some((text) => /balance score/i.test(text))).toBe(true);
  });

  it('reports unannotated images and split gaps', () => {
    const images = [
      makeImage('i1', { split: 'train' }),
      makeImage('i2', { split: 'train' }),
      makeImage('i3', { split: 'train' }),
      makeImage('i4', { split: 'train' }),
    ];
    const annotations = [
      makeAnnotation('a1', 'i1', 'bolt'),
      makeAnnotation('a2', 'i2', 'bolt'),
      makeAnnotation('a3', 'i3', 'gear'),
      makeAnnotation('a4', 'i4', 'washer'),
    ];

    const report = buildHealthReport(makeProject(), images, annotations, splitFromMeta);

    expect(report.unannotatedImages).toBe(0);
    expect(report.issues.some((issue) => /split/i.test(issue.title))).toBe(true);

    const partial = buildHealthReport(makeProject(), images.slice(0, 2), [annotations[0]], splitFromMeta);
    expect(partial.unannotatedImages).toBe(1);
    expect(partial.issues.some((issue) => /unannotated/i.test(issue.title))).toBe(true);
  });

  it('reports duplicate groups and tiny boxes', () => {
    const images = [
      makeImage('i1', { pHash: '0000000000000000', descriptor: [] }),
      makeImage('i2', { pHash: '0000000000000000', descriptor: [] }),
    ];
    const annotations = [
      makeAnnotation('tiny', 'i1', 'bolt', {
        geometry: { kind: 'bbox', x: 10, y: 10, width: 2, height: 2 },
      }),
    ];

    const report = buildHealthReport(makeProject(), images, annotations, splitFromMeta);

    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0].imageIds).toEqual(['i1', 'i2']);
    expect(report.tinyBoxes).toBe(1);
    expect(report.issues.some((issue) => /duplicate/i.test(issue.title))).toBe(true);
    expect(report.issues.some((issue) => /tiny annotation/i.test(issue.title))).toBe(true);
  });
});

describe('findSimilarImages', () => {
  it('orders candidates by combined descriptor and hash similarity', () => {
    const base = makeImage('base', { pHash: '0000000000000000', descriptor: [1, 0, 0] });
    const close = makeImage('close', { pHash: '0000000000000000', descriptor: [0.98, 0.12, 0] });
    const far = makeImage('far', { pHash: 'ffffffffffffffff', descriptor: [0, 1, 0] });

    const ordered = findSimilarImages([far, base, close], 'base');

    expect(ordered.map((match) => match.imageId)).toEqual(['close', 'far']);
    expect(ordered[0].score).toBeGreaterThan(ordered[1].score);
    expect(ordered[0].score).toBeLessThanOrEqual(1);
    expect(ordered[0].score).toBeGreaterThanOrEqual(0);
  });

  it('honours the limit and returns an empty list for unknown ids', () => {
    const base = makeImage('base');
    const other = makeImage('other');

    expect(findSimilarImages([base, other], 'base', 1).map((match) => match.imageId)).toEqual([
      'other',
    ]);
    expect(findSimilarImages([base, other], 'missing')).toEqual([]);
  });
});
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '@/autolabel/features';
import { predictImage, trainAutoLabel, type TrainDataset, type TrainImage } from '@/autolabel/pipeline';
import type { Annotation, AutoLabelSettings } from '@/core/types';
import { DEFAULT_AUTO_LABEL } from '@/core/types';

const W = 256;
const H = 256;

interface Scene {
  image: TrainImage;
  box: { x: number; y: number; width: number; height: number };
}

/** A deliberately simple but non-trivial visual world: colored texture with one object. */
function makeScene(seed: number, withObject = true): Scene {
  const rand = mulberry32(seed);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const noise = rand() * 30;
    const base = 80 + rand() * 40;
    data[i * 4] = base + noise;
    data[i * 4 + 1] = base + noise * 0.6;
    data[i * 4 + 2] = base - noise * 0.4;
    data[i * 4 + 3] = 255;
  }
  // Distractor stripes.
  for (let s = 0; s < 3; s++) {
    const x0 = Math.floor(rand() * W);
    const width = 6 + Math.floor(rand() * 10);
    const shade = 40 + rand() * 40;
    for (let y = 0; y < H; y++) {
      for (let x = x0; x < Math.min(W, x0 + width); x++) {
        const o = (y * W + x) * 4;
        data[o] = shade;
        data[o + 1] = shade;
        data[o + 2] = shade + 20;
      }
    }
  }
  const size = 44 + Math.floor(rand() * 10);
  const x = Math.floor(rand() * (W - size - 8)) + 4;
  const y = Math.floor(rand() * (H - size - 8)) + 4;
  if (withObject) {
    for (let yy = y; yy < y + size; yy++) {
      for (let xx = x; xx < x + size; xx++) {
        const o = (yy * W + xx) * 4;
        const checker = ((xx - x) >> 3) % 2 === ((yy - y) >> 3) % 2;
        data[o] = checker ? 235 : 180;
        data[o + 1] = checker ? 20 : 40;
        data[o + 2] = checker ? 200 : 160;
      }
    }
  }
  return {
    image: { id: `img_${seed}`, name: `${seed}.png`, width: W, height: H, data, scale: 1 },
    box: { x, y, width: size, height: size },
  };
}

function settings(overrides: Partial<AutoLabelSettings> = {}): AutoLabelSettings {
  return { ...DEFAULT_AUTO_LABEL, confidence: 0.5, maxPerImage: 5, nmsIou: 0.4, ...overrides };
}

describe('few-shot auto-label engine', () => {
  const scenes = Array.from({ length: 12 }, (_, i) => makeScene(100 + i));
  const annotations: Annotation[] = scenes.map((scene, index) => ({
    id: `ann_${index}`,
    projectId: 'p1',
    imageId: scene.image.id,
    classId: 'widget',
    geometry: { kind: 'bbox', ...scene.box },
    attributes: {},
    source: 'human',
    createdAt: index,
    updatedAt: index,
  }));

  const dataset: TrainDataset = {
    projectId: 'p1',
    projectType: 'object-detection',
    classes: [{ id: 'widget', name: 'widget', color: '#f00' }],
    images: scenes.map((s) => s.image),
    annotations,
    settings: settings(),
  };

  it('trains from a dozen boxes and finds the object in unseen images', () => {
    const { bundle } = trainAutoLabel(dataset);
    expect(bundle.classes).toHaveLength(1);
    expect(bundle.weights.length).toBe(bundle.bias.length * bundle.dim);
    expect(bundle.anchors.length).toBeGreaterThan(0);

    const testScenes = Array.from({ length: 6 }, (_, i) => makeScene(900 + i));
    let hits = 0;
    let truePositives = 0;
    let falsePositives = 0;
    for (const scene of testScenes) {
      const predictions = predictImage(bundle, scene.image, settings(), { sourceWidth: W, sourceHeight: H });
      let matched = false;
      for (const prediction of predictions) {
        if (prediction.geometry.kind !== 'bbox') continue;
        const px = prediction.geometry.x;
        const py = prediction.geometry.y;
        const x1 = Math.max(scene.box.x, px);
        const y1 = Math.max(scene.box.y, py);
        const x2 = Math.min(scene.box.x + scene.box.width, px + prediction.geometry.width);
        const y2 = Math.min(scene.box.y + scene.box.height, py + prediction.geometry.height);
        const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const union = scene.box.width * scene.box.height + prediction.geometry.width * prediction.geometry.height - inter;
        if (inter / union >= 0.4) {
          matched = true;
          truePositives += 1;
        } else {
          falsePositives += 1;
        }
      }
      if (matched) hits += 1;
    }
    expect(hits).toBeGreaterThanOrEqual(4);
    // Duplicate shifted windows used to count as extra detections; fusion and
    // calibration must keep precision usable at the default threshold.
    expect(truePositives / Math.max(1, truePositives + falsePositives)).toBeGreaterThanOrEqual(0.6);
  }, 120_000);

  it('round-trips the model through JSON without changing predictions', () => {
    const { bundle } = trainAutoLabel(dataset);
    const restored = JSON.parse(JSON.stringify(bundle));
    const scene = makeScene(1200);
    const first = predictImage(bundle, scene.image, settings(), { sourceWidth: W, sourceHeight: H });
    const second = predictImage(restored, scene.image, settings(), { sourceWidth: W, sourceHeight: H });
    expect(second.length).toBe(first.length);
    expect(second.map((p) => p.score.toFixed(5))).toEqual(first.map((p) => p.score.toFixed(5)));
  }, 120_000);

  it('refuses to train without annotations', () => {
    expect(() =>
      trainAutoLabel({ ...dataset, annotations: [] }),
    ).toThrow(/annotations/i);
  });
});
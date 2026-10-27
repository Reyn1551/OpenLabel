/// <reference lib="webworker" />
import type { WorkerRequest, WorkerResponse, WorkerImageInput, ProgressMessage } from '@/autolabel/protocol';
import { predictImage, trainAutoLabel, type TrainImage } from '@/autolabel/pipeline';

const cancelled = new Set<string>();

function post(message: WorkerResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
}

function progress(jobId: string, message: Omit<ProgressMessage, 'type' | 'jobId'>): void {
  post({ type: 'progress', jobId, ...message });
}

/** Decodes an image to working-resolution RGBA without touching the DOM. */
async function toWorkingImage(input: WorkerImageInput): Promise<TrainImage> {
  const bitmap = await createImageBitmap(input.blob);
  const longSide = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, 768 / longSide);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('OffscreenCanvas 2D is unavailable in this browser.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  bitmap.close();
  return { id: input.id, name: input.name, width, height, data, scale };
}

async function handleTrain(request: Extract<WorkerRequest, { type: 'train' }>): Promise<void> {
  const started = performance.now();
  const images: TrainImage[] = [];
  for (let index = 0; index < request.images.length; index++) {
    if (cancelled.has(request.jobId)) {
      post({ type: 'cancelled', jobId: request.jobId });
      return;
    }
    images.push(await toWorkingImage(request.images[index]));
    progress(request.jobId, {
      stage: 'features',
      progress: ((index + 1) / request.images.length) * 0.15,
      message: `Decoding images ${index + 1}/${request.images.length}`,
    });
  }
  const result = trainAutoLabel(
    {
      projectId: request.projectId,
      projectType: request.projectType,
      classes: request.classes,
      images,
      annotations: request.annotations,
      settings: request.settings,
    },
    (update) =>
      progress(request.jobId, {
        stage: update.stage,
        progress: 0.15 + update.progress * 0.85,
        message: update.message,
      }),
  );
  post({ type: 'trained', jobId: request.jobId, model: result.bundle, elapsedMs: performance.now() - started });
}

async function handlePredict(request: Extract<WorkerRequest, { type: 'predict' }>): Promise<void> {
  const started = performance.now();
  const results: { imageId: string; predictions: ReturnType<typeof predictImage> }[] = [];
  for (let index = 0; index < request.images.length; index++) {
    if (cancelled.has(request.jobId)) {
      post({ type: 'cancelled', jobId: request.jobId });
      return;
    }
    const input = request.images[index];
    const working = await toWorkingImage(input);
    const predictions = predictImage(request.model, working, request.settings, {
      sourceWidth: input.width,
      sourceHeight: input.height,
    });
    results.push({ imageId: input.id, predictions });
    progress(request.jobId, {
      stage: 'predicting',
      progress: (index + 1) / request.images.length,
      message: `Labeling ${index + 1}/${request.images.length}`,
    });
  }
  post({ type: 'predicted', jobId: request.jobId, results, elapsedMs: performance.now() - started });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    cancelled.add(request.jobId);
    return;
  }
  try {
    if (request.type === 'train') await handleTrain(request);
    else await handlePredict(request);
  } catch (error) {
    post({
      type: 'error',
      jobId: request.jobId,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    cancelled.delete(request.jobId);
  }
};
import type { Annotation, AutoLabelSettings, ClassDef, ModelBundle, Prediction, ProjectType } from '@/core/types';
import type { WorkerImageInput, WorkerRequest, WorkerResponse } from './protocol';

export interface JobProgress {
  stage: string;
  progress: number;
  message: string;
}

export interface JobHandle<T> {
  promise: Promise<T>;
  cancel: () => void;
}

export interface TrainPayload {
  projectId: string;
  projectType: ProjectType;
  classes: ClassDef[];
  annotations: Annotation[];
  settings: AutoLabelSettings;
  images: WorkerImageInput[];
}

export interface PredictPayload {
  model: ModelBundle;
  settings: AutoLabelSettings;
  images: WorkerImageInput[];
}

interface PendingJob {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: JobProgress) => void;
}

/**
 * Thin, typed wrapper around the auto-label worker.
 * One worker serves training, batch labeling and the deploy playground.
 */
class AutoLabelClient {
  private worker: Worker | null = null;
  private jobs = new Map<string, PendingJob>();
  private sequence = 0;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../workers/autolabel.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handle(event.data);
    worker.onerror = (event) => {
      const error = new Error(event.message || 'Auto-label worker crashed');
      for (const job of this.jobs.values()) job.reject(error);
      this.jobs.clear();
      this.worker?.terminate();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private handle(message: WorkerResponse): void {
    const job = this.jobs.get(message.jobId);
    if (!job) return;
    switch (message.type) {
      case 'progress':
        job.onProgress?.({
          stage: message.stage,
          progress: message.progress,
          message: message.message,
        });
        break;
      case 'trained':
        this.jobs.delete(message.jobId);
        (job.resolve as (value: ModelBundle) => void)(message.model);
        break;
      case 'predicted':
        this.jobs.delete(message.jobId);
        (job.resolve as (value: { imageId: string; predictions: Prediction[] }[]) => void)(message.results);
        break;
      case 'cancelled':
        this.jobs.delete(message.jobId);
        job.reject(new Error('Cancelled'));
        break;
      case 'error':
        this.jobs.delete(message.jobId);
        job.reject(new Error(message.message));
        break;
    }
  }

  private start<T>(request: WorkerRequest, onProgress?: (progress: JobProgress) => void): JobHandle<T> {
    const worker = this.ensureWorker();
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.jobs.set(request.jobId, {
      resolve: resolve as (value: never) => void,
      reject,
      onProgress,
    });
    worker.postMessage(request);
    return {
      promise,
      cancel: () => worker.postMessage({ type: 'cancel', jobId: request.jobId }),
    };
  }

  train(payload: TrainPayload, onProgress?: (progress: JobProgress) => void): JobHandle<ModelBundle> {
    const jobId = `train_${++this.sequence}`;
    return this.start<ModelBundle>({ type: 'train', jobId, ...payload }, onProgress);
  }

  predict(
    payload: PredictPayload,
    onProgress?: (progress: JobProgress) => void,
  ): JobHandle<{ imageId: string; predictions: Prediction[] }[]> {
    const jobId = `predict_${++this.sequence}`;
    return this.start({ type: 'predict', jobId, ...payload }, onProgress);
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.jobs.clear();
  }
}

export const autoLabelClient = new AutoLabelClient();
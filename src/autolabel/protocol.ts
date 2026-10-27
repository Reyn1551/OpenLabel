import type { Annotation, AutoLabelSettings, ProjectType, Prediction, ClassDef, ModelBundle } from '@/core/types';
import type { TrainProgress } from './pipeline';

export interface WorkerImageInput {
  id: string;
  name: string;
  width: number;
  height: number;
  blob: Blob;
}

export interface TrainRequest {
  type: 'train';
  jobId: string;
  projectId: string;
  projectType: ProjectType;
  classes: ClassDef[];
  annotations: Annotation[];
  settings: AutoLabelSettings;
  images: WorkerImageInput[];
}

export interface PredictRequest {
  type: 'predict';
  jobId: string;
  model: ModelBundle;
  settings: AutoLabelSettings;
  images: WorkerImageInput[];
}

export interface CancelRequest {
  type: 'cancel';
  jobId: string;
}

export type WorkerRequest = TrainRequest | PredictRequest | CancelRequest;

export interface ProgressMessage {
  type: 'progress';
  jobId: string;
  stage: TrainProgress['stage'] | 'predicting';
  progress: number;
  message: string;
}

export interface TrainDoneMessage {
  type: 'trained';
  jobId: string;
  model: ModelBundle;
  elapsedMs: number;
}

export interface PredictDoneMessage {
  type: 'predicted';
  jobId: string;
  results: { imageId: string; predictions: Prediction[] }[];
  elapsedMs: number;
}

export interface ErrorMessage {
  type: 'error';
  jobId: string;
  message: string;
}

export interface CancelledMessage {
  type: 'cancelled';
  jobId: string;
}

export type WorkerResponse = ProgressMessage | TrainDoneMessage | PredictDoneMessage | ErrorMessage | CancelledMessage;
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  Annotation,
  DatasetVersion,
  ImageBlob,
  ImageMeta,
  ModelBundle,
  Project,
} from './types';

export interface OpenLabelDB extends DBSchema {
  projects: {
    key: string;
    value: Project;
    indexes: { 'by-updated': number };
  };
  images: {
    key: string;
    value: ImageMeta;
    indexes: { 'by-project': string; 'by-batch': string; 'by-hash': string };
  };
  blobs: {
    key: string;
    value: ImageBlob;
  };
  annotations: {
    key: string;
    value: Annotation;
    indexes: { 'by-image': string; 'by-project': string };
  };
  versions: {
    key: string;
    value: DatasetVersion;
    indexes: { 'by-project': string };
  };
  models: {
    key: string;
    value: ModelBundle;
    indexes: { 'by-project': string };
  };
  meta: {
    key: string;
    value: unknown;
  };
}

export const DB_NAME = 'openlabel';
export const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<OpenLabelDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<OpenLabelDB>> {
  if (!dbPromise) {
    dbPromise = openDB<OpenLabelDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const projects = db.createObjectStore('projects', { keyPath: 'id' });
          projects.createIndex('by-updated', 'updatedAt');

          const images = db.createObjectStore('images', { keyPath: 'id' });
          images.createIndex('by-project', 'projectId');
          images.createIndex('by-batch', 'batchId');

          db.createObjectStore('blobs', { keyPath: 'id' });

          const annotations = db.createObjectStore('annotations', { keyPath: 'id' });
          annotations.createIndex('by-image', 'imageId');
          annotations.createIndex('by-project', 'projectId');

          const versions = db.createObjectStore('versions', { keyPath: 'id' });
          versions.createIndex('by-project', 'projectId');

          const models = db.createObjectStore('models', { keyPath: 'id' });
          models.createIndex('by-project', 'projectId');

          db.createObjectStore('meta');
        }
        // Content hashes are how peers name images, so the lookup must be O(1).
        if (oldVersion < 2) {
          tx.objectStore('images').createIndex('by-hash', 'hash');
        }
      },
    });
  }
  return dbPromise;
}

/** Test-only helper so suites start from a clean database. */
export async function resetDBForTests(): Promise<void> {
  if (dbPromise) {
    (await dbPromise).close();
    dbPromise = null;
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const req = indexedDB.deleteDatabase(DB_NAME);
  req.onsuccess = () => resolve();
  req.onerror = () => reject(req.error);
  req.onblocked = () => resolve();
  await promise;
}
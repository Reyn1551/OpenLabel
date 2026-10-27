import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Op, PeerId } from './types';

/**
 * Collaboration data lives in its own database so that project data migrations
 * never touch the replicated operation log and vice versa.
 */
export interface CollabDB extends DBSchema {
  ops: {
    key: string;
    value: { key: string; projectId: string; op: Op };
    indexes: { 'by-project': string };
  };
  meta: { key: string; value: unknown };
}

const DB_NAME = 'openlabel-collab';
const DB_VERSION = 1;
const PEER_KEY = 'openlabel-peer';

let dbPromise: Promise<IDBPDatabase<CollabDB>> | null = null;

function getDB(): Promise<IDBPDatabase<CollabDB>> {
  if (!dbPromise) {
    dbPromise = openDB<CollabDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const ops = db.createObjectStore('ops', { keyPath: 'key' });
        ops.createIndex('by-project', 'projectId');
        db.createObjectStore('meta');
      },
    });
  }
  return dbPromise;
}

function opKey(projectId: string, op: Op): string {
  return `${projectId}:${op.oid}`;
}

/** Appends operations in one transaction; duplicates are overwritten harmlessly. */
export async function appendOps(projectId: string, ops: Op[]): Promise<void> {
  if (ops.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('ops', 'readwrite');
  for (const op of ops) tx.store.put({ key: opKey(projectId, op), projectId, op });
  await tx.done;
}

/** Loads the project's whole operation log in append order. */
export async function loadOps(projectId: string): Promise<Op[]> {
  const db = await getDB();
  const rows = await db.getAllFromIndex('ops', 'by-project', projectId);
  return rows.map((row) => row.op);
}

export async function clearOps(projectId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('ops', 'readwrite');
  const keys = await tx.store.index('by-project').getAllKeys(projectId);
  for (const key of keys) tx.store.delete(key);
  await tx.done;
}

/**
 * Returns this tab's peer identity.
 *
 * Identity is per tab, not per profile: two tabs of the same browser share the
 * project database, so they must still count as two replicas. `sessionStorage`
 * survives reloads within the tab and is discarded with it.
 */
export function loadPeerId(create: () => PeerId): PeerId {
  const storage = globalThis.sessionStorage;
  const stored = storage?.getItem(PEER_KEY);
  if (typeof stored === 'string' && stored.length >= 8) return stored;
  const peer = create();
  storage?.setItem(PEER_KEY, peer);
  return peer;
}

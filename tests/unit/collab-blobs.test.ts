import { describe, expect, it } from 'vitest';
import {
  BLOB_CHUNK_BYTES,
  BlobSync,
  MAX_BLOB_BYTES,
  parseBlobMessage,
  type BlobMessage,
} from '@/collab/blobs';

const HASH = 'a'.repeat(64);

// jsdom ships a Blob without `arrayBuffer()`; browsers have it. Filling the gap
// keeps the production code free of a test-only branch.
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

/** A BlobSync wired to in-memory pipes so two instances can talk directly. */
function pair(options: { serve?: Blob | null } = {}) {
  const fromAtoB: unknown[] = [];
  const fromBtoA: unknown[] = [];
  const receivedByB: { hash: string; blob: Blob }[] = [];
  const missingAtB: string[] = [];

  const a = new BlobSync({
    peer: 'peer-a',
    send: async (message) => {
      fromAtoB.push(message);
    },
    read: async () => options.serve ?? null,
    received: () => undefined,
  });

  const b = new BlobSync({
    peer: 'peer-b',
    send: async (message) => {
      fromBtoA.push(message);
    },
    read: async () => null,
    received: (hash, blob) => receivedByB.push({ hash, blob }),
    onMissing: (hash) => missingAtB.push(hash),
  });

  /** Moves queued messages to the peer until both directions stay empty. */
  const drain = async () => {
    let idleRounds = 0;
    for (let round = 0; round < 500 && idleRounds < 5; round += 1) {
      const aBatch = fromAtoB.splice(0);
      const bBatch = fromBtoA.splice(0);
      if (aBatch.length === 0 && bBatch.length === 0) {
        idleRounds += 1;
      } else {
        idleRounds = 0;
      }
      for (const message of bBatch) a.handle(message);
      for (const message of aBatch) b.handle(message);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  return { a, b, drain, receivedByB, missingAtB, fromAtoB, fromBtoA };
}

describe('blob message validation', () => {
  it('accepts a well-formed request', () => {
    expect(parseBlobMessage({ v: 1, t: 'blob.req', from: 'peer-b', hash: HASH })).not.toBeNull();
  });

  it('rejects unknown versions, kinds, and malformed hashes', () => {
    expect(parseBlobMessage({ v: 2, t: 'blob.req', from: 'p', hash: HASH })).toBeNull();
    expect(parseBlobMessage({ v: 1, t: 'blob.evil', from: 'p', hash: HASH })).toBeNull();
    expect(parseBlobMessage({ v: 1, t: 'blob.req', from: 'p', hash: '../../etc/passwd' })).toBeNull();
    expect(parseBlobMessage({ v: 1, t: 'blob.req', from: '', hash: HASH })).toBeNull();
    expect(parseBlobMessage(null)).toBeNull();
    expect(parseBlobMessage('not an object')).toBeNull();
  });

  it('rejects a chunk whose sequence is outside the declared total', () => {
    const base = { v: 1, t: 'blob.res', from: 'p', hash: HASH, total: 2, data: 'AA==' };
    expect(parseBlobMessage({ ...base, seq: 0 })).not.toBeNull();
    expect(parseBlobMessage({ ...base, seq: 2 })).toBeNull();
    expect(parseBlobMessage({ ...base, seq: -1 })).toBeNull();
    expect(parseBlobMessage({ ...base, seq: 0, total: 0 })).toBeNull();
  });

  it('rejects an empty chunk body', () => {
    expect(
      parseBlobMessage({ v: 1, t: 'blob.res', from: 'p', hash: HASH, seq: 0, total: 1, data: '' }),
    ).toBeNull();
  });
});

describe('chunked transfer', () => {
  it('moves a blob larger than one chunk and verifies every byte', async () => {
    const payload = new Uint8Array(BLOB_CHUNK_BYTES * 2 + 517);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;

    const harness = pair({ serve: new Blob([payload]) });
    harness.b.request(HASH);
    expect(harness.missingAtB).toEqual([HASH]);
    await harness.drain();

    expect(harness.receivedByB).toHaveLength(1);
    expect(harness.receivedByB[0].hash).toBe(HASH);
    const bytes = new Uint8Array(await harness.receivedByB[0].blob.arrayBuffer());
    expect(bytes.length).toBe(payload.length);
    expect(bytes).toEqual(payload);

    harness.a.close();
    harness.b.close();
  });

  it('ignores its own echo and never answers its own request', async () => {
    const { a, drain, receivedByB } = pair({ serve: new Blob([new Uint8Array(8)]) });
    const own: BlobMessage = { v: 1, t: 'blob.req', from: 'peer-a', hash: HASH };
    expect(a.handle(own)).toBe(false);
    await drain();
    expect(receivedByB).toHaveLength(0);
    a.close();
  });

  it('drops a transfer that exceeds the size ceiling', async () => {
    const tooBig = new Blob([new Uint8Array(MAX_BLOB_BYTES + 1)]);
    const harness = pair({ serve: tooBig });
    harness.b.request(HASH);
    await harness.drain();
    // The sender refuses to stream it, so nothing arrives and nothing crashes.
    expect(harness.receivedByB).toHaveLength(0);
    harness.a.close();
    harness.b.close();
  });

  it('records every request for a hash it is missing', () => {
    const harness = pair({ serve: null });
    harness.b.request(HASH);
    harness.b.request(HASH);
    expect(harness.missingAtB).toEqual([HASH, HASH]);
    harness.a.close();
    harness.b.close();
  });
});

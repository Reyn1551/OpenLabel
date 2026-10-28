/**
 * Chunked image transfer over an established peer connection.
 *
 * Annotations are useless without pixels, and the CRDT deliberately carries no
 * bytes. When a peer learns about an image it does not have, it asks for it over
 * the same data channel and stores the result locally, so a paired device ends
 * up with a complete dataset and keeps working after the sender goes away.
 *
 * Messages are JSON with base64 chunks because the data channel already speaks
 * strings and one framing path is easier to audit than two. Chunks are 32 KiB,
 * which keeps a frame far below the 1 MiB op cap and leaves room for the
 * channel's own buffering.
 */

import type { PeerId } from './types';

export const BLOB_CHUNK_BYTES = 32 * 1024;
/** Refuse oversized transfers instead of filling a peer's disk. */
export const MAX_BLOB_BYTES = 48 * 1024 * 1024;

export type BlobMessageKind = 'blob.req' | 'blob.res' | 'blob.end';

export interface BlobMessage {
  v: 1;
  t: BlobMessageKind;
  from: PeerId;
  hash: string;
  seq?: number;
  total?: number;
  data?: string;
}

const HASH_PATTERN = /^[0-9a-f]{8,128}$/u;

function isBlobMessage(value: unknown): value is BlobMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return false;
  const kind = record.t;
  if (kind !== 'blob.req' && kind !== 'blob.res' && kind !== 'blob.end') return false;
  if (typeof record.from !== 'string' || record.from.length === 0) return false;
  if (typeof record.hash !== 'string' || !HASH_PATTERN.test(record.hash)) return false;
  if (kind === 'blob.res') {
    if (typeof record.seq !== 'number' || !Number.isInteger(record.seq) || record.seq < 0) return false;
    if (typeof record.total !== 'number' || !Number.isInteger(record.total) || record.total <= 0) return false;
    if (record.seq >= record.total) return false;
    if (typeof record.data !== 'string' || record.data.length === 0) return false;
  }
  return true;
}

/** Returns the message when it is a blob frame, `null` when it belongs elsewhere. */
export function parseBlobMessage(value: unknown): BlobMessage | null {
  return isBlobMessage(value) ? value : null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface BlobSyncOptions {
  /** This replica's id; frames echoing it are ignored. */
  peer: PeerId;
  /** Sends one message to the peer, honouring channel backpressure. */
  send: (message: BlobMessage) => Promise<void>;
  /** Reads a blob for a hash, or `null` when this device does not have it. */
  read: (hash: string) => Promise<Blob | null>;
  /** Called once a complete blob arrived and was verified. */
  received: (hash: string, blob: Blob) => void;
  /** Reports hashes this device is missing, so the UI can show progress. */
  onMissing?: (hash: string) => void;
}

interface Incoming {
  parts: Map<number, string>;
  total: number;
  bytes: number;
}

/**
 * Tracks inbound and outbound image transfers for one peer connection.
 *
 * The sender serializes transfers, because a second multi-megabyte stream on the
 * same channel would only add buffering without improving throughput.
 */
export class BlobSync {
  private readonly incoming = new Map<string, Incoming>();
  private readonly outbound: string[] = [];
  private readonly served = new Set<string>();
  private pumping = false;
  private closed = false;

  constructor(private readonly options: BlobSyncOptions) {}

  /** Asks the peer for an image this device does not have. */
  request(hash: string): void {
    if (this.closed || this.served.has(hash)) return;
    this.options.onMissing?.(hash);
    void this.options.send({ v: 1, t: 'blob.req', from: this.options.peer, hash });
  }

  /** Handles one untrusted control message; returns true when it was ours. */
  handle(raw: unknown): boolean {
    if (this.closed) return false;
    const message = parseBlobMessage(raw);
    if (!message || message.from === this.options.peer) return false;

    if (message.t === 'blob.req') {
      this.enqueueServe(message.hash);
      return true;
    }

    if (message.t === 'blob.res') {
      this.acceptChunk(message);
      return true;
    }

    this.finishIncoming(message.hash);
    return true;
  }

  close(): void {
    this.closed = true;
    this.incoming.clear();
    this.outbound.length = 0;
  }

  private enqueueServe(hash: string): void {
    if (this.served.has(hash) || this.outbound.includes(hash)) return;
    this.outbound.push(hash);
    this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (this.outbound.length > 0 && !this.closed) {
        const hash = this.outbound.shift()!;
        if (this.served.has(hash)) continue;
        const blob = await this.options.read(hash).catch(() => null);
        if (!blob) continue;
        if (blob.size > MAX_BLOB_BYTES) continue;
        this.served.add(hash);
        await this.sendBlob(hash, blob);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async sendBlob(hash: string, blob: Blob): Promise<void> {
    const total = Math.max(1, Math.ceil(blob.size / BLOB_CHUNK_BYTES));
    for (let seq = 0; seq < total; seq += 1) {
      if (this.closed) return;
      const slice = blob.slice(seq * BLOB_CHUNK_BYTES, (seq + 1) * BLOB_CHUNK_BYTES);
      const bytes = new Uint8Array(await slice.arrayBuffer());
      await this.options.send({
        v: 1,
        t: 'blob.res',
        from: this.options.peer,
        hash,
        seq,
        total,
        data: bytesToBase64(bytes),
      });
    }
    await this.options.send({ v: 1, t: 'blob.end', from: this.options.peer, hash });
  }

  private acceptChunk(message: BlobMessage): void {
    const total = message.total ?? 0;
    const seq = message.seq ?? 0;
    const data = message.data ?? '';
    if (total <= 0 || seq >= total) return;

    let entry = this.incoming.get(message.hash);
    if (!entry) {
      entry = { parts: new Map(), total, bytes: 0 };
      this.incoming.set(message.hash, entry);
    }
    if (entry.total !== total) {
      // A different total means the sender restarted this hash; start over.
      entry = { parts: new Map(), total, bytes: 0 };
      this.incoming.set(message.hash, entry);
    }
    if (entry.parts.has(seq)) return;

    const bytes = base64ToBytes(data);
    entry.bytes += bytes.length;
    if (entry.bytes > MAX_BLOB_BYTES) {
      this.incoming.delete(message.hash);
      return;
    }
    entry.parts.set(seq, data);
    if (entry.parts.size === entry.total) this.finishIncoming(message.hash);
  }

  private finishIncoming(hash: string): void {
    const entry = this.incoming.get(hash);
    if (!entry) return;
    this.incoming.delete(hash);
    if (entry.parts.size !== entry.total) return;

    // Each chunk is its own base64 string with its own padding, so they must be
    // decoded one by one. Joining the strings first produces invalid base64.
    let total = 0;
    const decoded: Uint8Array[] = [];
    for (let seq = 0; seq < entry.total; seq += 1) {
      const part = entry.parts.get(seq);
      if (part === undefined) return;
      const bytes = base64ToBytes(part);
      decoded.push(bytes);
      total += bytes.length;
      if (total > MAX_BLOB_BYTES) return;
    }

    const joined = new Uint8Array(total);
    let offset = 0;
    for (const bytes of decoded) {
      joined.set(bytes, offset);
      offset += bytes.length;
    }
    this.options.received(hash, new Blob([joined.buffer as ArrayBuffer]));
  }
}

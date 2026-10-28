/**
 * Chunked image transfer over an established peer connection.
 *
 * Annotations are useless without pixels, and the CRDT deliberately carries no
 * bytes. When a peer learns about an image it does not have, it asks for it over
 * the same data channel and stores the result locally, so a paired device ends
 * up with a complete dataset and keeps working after the sender goes away.
 *
 * Three rules make this reliable, and each one exists because dropping it caused
 * silent holes in a real dataset:
 *
 * 1. A request is *desired state*, not a one-shot message. The receiver keeps a
 *    wanted set and re-announces it whenever the channel opens and periodically
 *    while anything is still missing. A request sent before the channel is ready
 *    is therefore not lost.
 * 2. A hash is only marked served after the last chunk was handed to the channel.
 *    An interrupted transfer is retried instead of being remembered as done.
 * 3. Every received image is checked against its content address (SHA-256 of the
 *    bytes). A corrupted transfer is discarded and requested again rather than
 *    stored as a broken photo.
 */

import type { PeerId } from './types';

/**
 * 16 KiB is the portable message size: safely under every interoperable SCTP
 * limit and small enough not to monopolise the send window.
 */
export const BLOB_CHUNK_BYTES = 16 * 1024;
/** Refuse oversized transfers instead of filling a peer's disk. */
export const MAX_BLOB_BYTES = 48 * 1024 * 1024;
/** How often the receiver re-announces what it is still missing. */
export const RETRY_INTERVAL_MS = 3000;
/** A partial download older than this is abandoned and requested again. */
export const TRANSFER_TIMEOUT_MS = 30_000;

export type BlobMessageKind = 'blob.req' | 'blob.res' | 'blob.end' | 'blob.none';

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
  if (kind !== 'blob.req' && kind !== 'blob.res' && kind !== 'blob.end' && kind !== 'blob.none') {
    return false;
  }
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

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface BlobSyncOptions {
  /** This replica's id; frames echoing it are ignored. */
  peer: PeerId;
  /** Sends one message to the peer, honouring channel backpressure. */
  send: (message: BlobMessage) => Promise<void>;
  /** Reads a blob for a hash, or `null` when this device does not have it. */
  read: (hash: string) => Promise<Blob | null>;
  /**
   * Stores a complete, verified blob. The hash stays wanted until this resolves,
   * so a storage failure (or a row that has not replicated yet) is retried
   * instead of leaving a permanently missing image.
   */
  received: (hash: string, blob: Blob) => void | Promise<void>;
  /** Reports hashes this device is missing, so the UI can show progress. */
  onMissing?: (hash: string) => void;
  /** Called when a peer says it cannot serve a hash, so it can be sourced elsewhere. */
  onUnavailable?: (hash: string) => void;
}

interface Incoming {
  parts: Map<number, string>;
  total: number;
  bytes: number;
  updatedAt: number;
}

/**
 * Tracks inbound and outbound image transfers for one peer connection.
 *
 * The sender serializes transfers, because a second multi-megabyte stream on the
 * same channel would only add buffering without improving throughput.
 */
export class BlobSync {
  private readonly incoming = new Map<string, Incoming>();
  /** Hashes this device wants and has not received yet. Survives retries. */
  private readonly wanted = new Set<string>();
  private readonly queue: string[] = [];
  /** Written only after a transfer completed, so a failure can retry. */
  private readonly served = new Set<string>();
  private readonly sending = new Set<string>();
  private pumping = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: BlobSyncOptions) {}

  /** Declares that this device is missing a hash and should keep asking for it. */
  request(hash: string): void {
    if (this.closed || this.served.has(hash) || this.wanted.has(hash)) return;
    this.wanted.add(hash);
    this.options.onMissing?.(hash);
    void this.send({ v: 1, t: 'blob.req', from: this.options.peer, hash });
  }

  /**
   * Called when the data channel becomes usable.
   *
   * Everything still wanted is re-announced and the retry timer starts, which is
   * what turns a request that raced the connection into a delivered image.
   */
  onOpen(): void {
    if (this.closed) return;
    for (const hash of this.wanted) {
      void this.send({ v: 1, t: 'blob.req', from: this.options.peer, hash });
    }
    this.startTimer();
  }

  /** Hashes still missing on this device, for progress reporting and tests. */
  missing(): string[] {
    return [...this.wanted];
  }

  /** Handles one untrusted control message; returns true when it was ours. */
  handle(raw: unknown): boolean {
    if (this.closed) return false;
    const message = parseBlobMessage(raw);
    if (!message || message.from === this.options.peer) return false;

    switch (message.t) {
      case 'blob.req':
        this.enqueueServe(message.hash);
        return true;
      case 'blob.res':
        this.acceptChunk(message);
        return true;
      case 'blob.none':
        this.wanted.delete(message.hash);
        this.options.onUnavailable?.(message.hash);
        return true;
      default:
        this.finishIncoming(message.hash);
        return true;
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.incoming.clear();
    this.queue.length = 0;
    this.wanted.clear();
    this.sending.clear();
  }

  private async send(message: BlobMessage): Promise<boolean> {
    if (this.closed) return false;
    try {
      await this.options.send(message);
      return true;
    } catch {
      return false;
    }
  }

  private startTimer(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      if (this.closed) return;
      this.expirePartials();
      if (this.wanted.size === 0) {
        clearInterval(this.timer);
        this.timer = undefined;
        return;
      }
      for (const hash of this.wanted) {
        void this.send({ v: 1, t: 'blob.req', from: this.options.peer, hash });
      }
    }, RETRY_INTERVAL_MS);
  }

  /** Drops a stalled partial so the next request starts from a clean slate. */
  private expirePartials(): void {
    const cutoff = Date.now() - TRANSFER_TIMEOUT_MS;
    for (const [hash, entry] of this.incoming) {
      if (entry.updatedAt >= cutoff) continue;
      this.incoming.delete(hash);
    }
  }

  private enqueueServe(hash: string): void {
    if (this.served.has(hash) || this.sending.has(hash) || this.queue.includes(hash)) return;
    this.queue.push(hash);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const hash = this.queue.shift()!;
        if (this.served.has(hash) || this.sending.has(hash)) continue;
        const blob = await this.options.read(hash).catch(() => null);
        if (!blob) {
          // Tell the peer instead of leaving it waiting; another peer may have it.
          void this.send({ v: 1, t: 'blob.none', from: this.options.peer, hash });
          continue;
        }
        if (blob.size > MAX_BLOB_BYTES) {
          void this.send({ v: 1, t: 'blob.none', from: this.options.peer, hash });
          continue;
        }
        this.sending.add(hash);
        try {
          const complete = await this.sendBlob(hash, blob);
          if (complete) this.served.add(hash);
        } finally {
          this.sending.delete(hash);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async sendBlob(hash: string, blob: Blob): Promise<boolean> {
    const total = Math.max(1, Math.ceil(blob.size / BLOB_CHUNK_BYTES));
    for (let seq = 0; seq < total; seq += 1) {
      if (this.closed) return false;
      const slice = blob.slice(seq * BLOB_CHUNK_BYTES, (seq + 1) * BLOB_CHUNK_BYTES);
      const bytes = new Uint8Array(await slice.arrayBuffer());
      const ok = await this.send({
        v: 1,
        t: 'blob.res',
        from: this.options.peer,
        hash,
        seq,
        total,
        data: bytesToBase64(bytes),
      });
      if (!ok) return false;
    }
    return this.send({ v: 1, t: 'blob.end', from: this.options.peer, hash });
  }

  private acceptChunk(message: BlobMessage): void {
    const total = message.total ?? 0;
    const seq = message.seq ?? 0;
    const data = message.data ?? '';
    if (total <= 0 || seq >= total) return;

    let entry = this.incoming.get(message.hash);
    if (!entry || entry.total !== total) {
      // A different total means the sender restarted this hash; start over.
      entry = { parts: new Map(), total, bytes: 0, updatedAt: Date.now() };
      this.incoming.set(message.hash, entry);
    }
    if (entry.parts.has(seq)) return;

    const bytes = base64ToBytes(data);
    entry.bytes += bytes.length;
    entry.updatedAt = Date.now();
    if (entry.bytes > MAX_BLOB_BYTES) {
      this.incoming.delete(message.hash);
      return;
    }
    entry.parts.set(seq, data);
    if (entry.parts.size === entry.total) void this.finishIncoming(message.hash);
  }

  private async finishIncoming(hash: string): Promise<void> {
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

    const joined = new Uint8Array(new ArrayBuffer(total));
    let offset = 0;
    for (const bytes of decoded) {
      joined.set(bytes, offset);
      offset += bytes.length;
    }

    // Content address check: a truncated or altered transfer must not become a
    // photo that renders as garbage for the rest of the project's life.
    const digest = await sha256Hex(joined);
    if (digest && !hash.startsWith(digest) && !digest.startsWith(hash)) {
      this.wanted.add(hash);
      return;
    }

    try {
      await this.options.received(hash, new Blob([joined.buffer as ArrayBuffer]));
      this.wanted.delete(hash);
    } catch {
      // Keep it wanted; the retry timer asks again.
      this.wanted.add(hash);
    }
  }
}

import type { OpKind, PeerId, Stamp } from './types';

/**
 * Lamport clock for one replica.
 *
 * `observe` only raises the counter, never lowers it, so any stamp created after
 * seeing a remote write is strictly greater than that write. That is what makes
 * last-writer-wins resolve to the same winner on every replica.
 */
export class LamportClock {
  readonly peer: PeerId;
  private counter: number;

  constructor(peer: PeerId, counter = 0) {
    this.peer = peer;
    this.counter = Math.max(0, Math.trunc(counter));
  }

  /** Highest counter observed so far. */
  get time(): number {
    return this.counter;
  }

  /** Advance the counter and stamp a locally authored operation. */
  tick(): Stamp {
    this.counter += 1;
    return { t: this.counter, p: this.peer };
  }

  /** Absorb a remote stamp; the local counter catches up to it. */
  observe(stamp: Stamp): void {
    if (stamp.t > this.counter) this.counter = stamp.t;
  }

  /**
   * Stable operation id. One peer stamps at most one operation per counter
   * value, so kind + stamp identifies an operation for the life of the
   * collaboration.
   */
  nextOpId(kind: OpKind, stamp: Stamp): string {
    return `${stamp.p}:${stamp.t}:${kind}`;
  }
}

/** Random replica identity: 16 lowercase hex characters from 8 random bytes. */
export function randomPeerId(): PeerId {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const byte of bytes) id += byte.toString(16).padStart(2, '0');
  return id;
}
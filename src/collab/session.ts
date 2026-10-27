import { LamportClock, randomPeerId } from './clock';
import { appendOps, loadOps, loadPeerId } from './storage';
import {
  applyOps,
  emptyState,
  opsSince,
  versionVector,
  type CollabState,
} from './state';
import type { Op, PeerId, Stamp } from './types';
import type { Transport } from './transport';

/** Operations per frame when a peer catches up; keeps WebRTC frames small. */
export const BACKFILL_CHUNK = 200;

export interface SessionSnapshot {
  state: CollabState;
  peers: PeerId[];
  pendingPeers: number;
}

export type SessionListener = (snapshot: SessionSnapshot) => void;

/**
 * Owns one project's replicated state: the operation log, the Lamport clock and
 * the transport currently attached. Local operations are applied immediately so
 * the UI never waits for a round trip; remote operations converge through the
 * same state machine.
 */
export class CollabSession {
  private readonly listeners = new Set<SessionListener>();
  private readonly peers = new Map<PeerId, 'pending' | 'connected'>();
  /** Membership index for the log; keeps dedupe O(1) at 50k+ operations. */
  private readonly seen = new Set<string>();
  private transport: Transport | null = null;

  private constructor(
    readonly projectId: string,
    readonly peer: PeerId,
    readonly clock: LamportClock,
    public state: CollabState,
    private log: Op[],
  ) {}

  /** Replays the persisted log so a reload keeps the same merged view. */
  static async open(projectId: string): Promise<CollabSession> {
    const peer = loadPeerId(randomPeerId);
    const ops = await loadOps(projectId);
    const clock = new LamportClock(peer);
    for (const op of ops) clock.observe(op.s);
    const session = new CollabSession(projectId, peer, clock, applyOps(emptyState(), ops), ops);
    for (const op of ops) session.seen.add(op.oid);
    return session;
  }

  nextStamp(): Stamp {
    return this.clock.tick();
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): SessionSnapshot {
    return {
      state: this.state,
      peers: [...this.peers.entries()].filter(([, status]) => status === 'connected').map(([peer]) => peer),
      pendingPeers: [...this.peers.values()].filter((status) => status === 'pending').length,
    };
  }

  attach(transport: Transport): void {
    this.detach();
    this.transport = transport;
    // Announce our version vector; the peer replies with whatever we are missing.
    transport.send([], versionVector(this.state));
  }

  detach(): void {
    this.transport?.close();
    this.transport = null;
  }

  /** Applies a local operation set, persists it, and notifies peers. */
  submit(ops: Op[]): void {
    if (ops.length === 0) return;
    this.state = applyOps(this.state, ops);
    this.log = this.log.concat(ops);
    for (const op of ops) this.seen.add(op.oid);
    void appendOps(this.projectId, ops);
    this.transport?.send(ops);
    this.emit();
  }

  /** Applies operations received from a peer and answers with anything missing. */
  receive(ops: Op[], vv: Record<PeerId, number>): void {
    // Frame origin is authoritative presence: BroadcastChannel has no join event.
    for (const peer of Object.keys(vv)) {
      if (peer !== this.peer) this.peers.set(peer, 'connected');
    }
    if (ops.length > 0) {
      this.state = applyOps(this.state, ops);
      const fresh = ops.filter((op) => !this.seen.has(op.oid));
      if (fresh.length > 0) {
        this.log = this.log.concat(fresh);
        for (const op of fresh) this.seen.add(op.oid);
        void appendOps(this.projectId, fresh);
      }
      this.emit();
    }
    // Chunk large catch-ups so a single data-channel frame stays small.
    const missing = opsSince(this.log, vv);
    for (let index = 0; index < missing.length; index += BACKFILL_CHUNK) {
      this.transport?.send(missing.slice(index, index + BACKFILL_CHUNK), versionVector(this.state));
    }
  }

  markPeer(peer: PeerId, status: 'pending' | 'connected'): void {
    if (status === 'connected') this.peers.set(peer, 'connected');
    else this.peers.delete(peer);
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
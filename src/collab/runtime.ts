import { startStudioBridge, type StudioBridge } from './bridge';
import { CollabSession } from './session';
import { BroadcastTransport, WebRtcTransport, type Transport, type TransportEvents } from './transport';
import type { Op, PeerId, VersionVector } from './types';

/**
 * Fan-out transport: one session can talk over same-profile tabs, a manual
 * WebRTC pairing, or both at once, without knowing which is which.
 */
export class FanoutTransport implements Transport {
  private readonly members = new Set<Transport>();

  add(transport: Transport): void {
    this.members.add(transport);
  }

  remove(transport: Transport): void {
    this.members.delete(transport);
    transport.close();
  }

  send(ops: Op[], vv?: VersionVector): void {
    for (const member of this.members) member.send(ops, vv);
  }

  close(): void {
    for (const member of this.members) member.close();
    this.members.clear();
  }
}

export interface CollabRuntime {
  session: CollabSession;
  bridge: StudioBridge;
  channel: BroadcastTransport;
  fanout: FanoutTransport;
  /** Opens a LAN pairing as the invite creator; resolves with the offer code. */
  createInvite(): Promise<string>;
  /** Joins a pairing from an offer code; resolves with the answer code to return. */
  acceptInvite(code: string): Promise<string>;
  /** Completes the creator side once the joiner returns the answer code. */
  acceptAnswer(code: string): Promise<void>;
  stop(): void;
}

const runtimes = new Map<string, Promise<CollabRuntime>>();

function transportEvents(session: CollabSession): TransportEvents {
  return {
    onOps: (ops, vv) => session.receive(ops, vv),
    onPeer: (peer: PeerId, status) => session.markPeer(peer, status === 'connected' ? 'connected' : 'pending'),
  };
}

export function ensureCollab(projectId: string): Promise<CollabRuntime> {
  const existing = runtimes.get(projectId);
  if (existing) return existing;

  const created = (async (): Promise<CollabRuntime> => {
    const session = await CollabSession.open(projectId);
    const events = transportEvents(session);
    const fanout = new FanoutTransport();
    const channel = new BroadcastTransport(session.peer, events, `openlabel-collab:${projectId}`);
    fanout.add(channel);
    session.attach(fanout);
    const bridge = startStudioBridge(session);

    let pendingOffer: WebRtcTransport | null = null;

    return {
      session,
      bridge,
      channel,
      fanout,
      async createInvite() {
        pendingOffer = new WebRtcTransport(session.peer, events);
        fanout.add(pendingOffer);
        return pendingOffer.createInvite();
      },
      async acceptInvite(code: string) {
        const transport = new WebRtcTransport(session.peer, events);
        fanout.add(transport);
        return transport.acceptInvite(code);
      },
      async acceptAnswer(code: string) {
        if (!pendingOffer) throw new Error('Create an invite before accepting an answer.');
        await pendingOffer.acceptAnswer(code);
        pendingOffer = null;
      },
      stop() {
        bridge.stop();
        session.detach();
      },
    };
  })();

  runtimes.set(projectId, created);
  created.catch(() => runtimes.delete(projectId));
  return created;
}
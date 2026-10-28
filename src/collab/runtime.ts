import {
  getImageBlob,
  getImageByHash,
  getProject,
  listImages,
  putImages,
} from '@/core/repo';
import { computeDescriptor, computePHash, decodeImage, makeThumbnail } from '@/core/image';
import { BlobSync } from './blobs';
import { startStudioBridge, type StudioBridge } from './bridge';
import {
  buildInviteLink,
  decodeSignal,
  decodeSignalLink,
  encodeSignal,
  encodeSignalLink,
  SIGNAL_PREFIX_DEFLATE,
} from './signaling';
import { CollabSession } from './session';
import { BroadcastTransport, WebRtcTransport, type Transport, type TransportEvents } from './transport';
import type { Op, VersionVector } from './types';

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

interface PeerLink {
  transport: WebRtcTransport;
  blobs: BlobSync;
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
  /** Same three steps, but returning a link the other person can click. */
  createInviteLink(): Promise<string>;
  acceptInviteLink(code: string): Promise<string>;
  stop(): void;
}

const runtimes = new Map<string, Promise<CollabRuntime>>();

/**
 * The transport decodes `OL1.` codes synchronously, so a deflated `OL2.` code is
 * expanded back to that form before it reaches the peer connection.
 */
async function toPlainCode(code: string): Promise<string> {
  if (!code.trim().startsWith(SIGNAL_PREFIX_DEFLATE)) return code.trim();
  return encodeSignal(await decodeSignalLink(code));
}

/** Reads a stored image by its content hash; `null` when this device lacks it. */
async function readBlobByHash(hash: string): Promise<Blob | null> {
  const image = await getImageByHash(hash);
  if (!image) return null;
  return (await getImageBlob(image.id)) ?? null;
}

/**
 * Stores pixels that arrived from a peer, deriving the thumbnail and the
 * descriptor that the rest of the app expects. The row itself was created when
 * the image metadata replicated, so this only fills in the bytes.
 */
async function storeIncomingBlob(hash: string, blob: Blob): Promise<void> {
  const image = await getImageByHash(hash);
  if (!image) return;
  if (await getImageBlob(image.id)) return;

  const decoded = await decodeImage(blob);
  try {
    const [thumb, pHash, descriptor] = await Promise.all([
      makeThumbnail(decoded.bitmap),
      computePHash(decoded.bitmap),
      computeDescriptor(decoded.bitmap),
    ]);
    await putImages([
      { meta: { ...image, bytes: blob.size, pHash, descriptor }, blob, thumb },
    ]);
  } finally {
    decoded.bitmap.close();
  }
}

export function ensureCollab(projectId: string): Promise<CollabRuntime> {
  const existing = runtimes.get(projectId);
  if (existing) return existing;

  const created = (async (): Promise<CollabRuntime> => {
    const session = await CollabSession.open(projectId);
    const fanout = new FanoutTransport();
    const channel = new BroadcastTransport(
      session.peer,
      { onOps: (ops, vv) => session.receive(ops, vv), onPeer: () => undefined },
      `openlabel-collab:${projectId}`,
    );
    fanout.add(channel);
    session.attach(fanout);

    const links: PeerLink[] = [];
    let pendingOffer: PeerLink | null = null;
    const projectName = (await getProject(projectId))?.name ?? '';
    const bridge = startStudioBridge(session, {
      requestBlob: (hash) => {
        for (const link of links) link.blobs.request(hash);
      },
    });

    /** Asks paired peers for every image this device knows about but lacks. */
    const requestMissing = async (): Promise<void> => {
      if (links.length === 0) return;
      for (const image of await listImages(projectId)) {
        if (await getImageBlob(image.id)) continue;
        for (const link of links) link.blobs.request(image.hash);
      }
    };

    /**
     * Wires one WebRTC pair: CRDT frames flow through the session, everything
     * else is an image transfer. Each pair keeps its own blob state so two peers
     * cannot mix partial downloads.
     */
    const openPeer = (): PeerLink => {
      let handler: ((raw: unknown) => void) | null = null;
      const events: TransportEvents = {
        onOps: (ops, vv) => session.receive(ops, vv),
        onPeer: (peer, status) => {
          session.markPeer(peer, status === 'connected' ? 'connected' : 'pending');
          if (status === 'connected') {
            session.announce();
            void requestMissing();
          }
        },
        onControl: (raw) => handler?.(raw),
      };
      const transport = new WebRtcTransport(session.peer, events);
      const blobs = new BlobSync({
        peer: session.peer,
        send: (message) => transport.sendControl(message),
        read: readBlobByHash,
        received: (hash, blob) => void storeIncomingBlob(hash, blob),
      });
      handler = (raw) => {
        blobs.handle(raw);
      };
      const link: PeerLink = { transport, blobs };
      links.push(link);
      fanout.add(transport);
      return link;
    };

    return {
      session,
      bridge,
      channel,
      fanout,
      async createInvite() {
        pendingOffer = openPeer();
        return pendingOffer.transport.createInvite();
      },
      async acceptInvite(code: string) {
        const link = openPeer();
        return link.transport.acceptInvite(await toPlainCode(code));
      },
      async acceptAnswer(code: string) {
        const link = pendingOffer;
        if (!link) throw new Error('Create an invite before accepting an answer.');
        await link.transport.acceptAnswer(await toPlainCode(code));
        pendingOffer = null;
      },
      async createInviteLink() {
        const link = openPeer();
        pendingOffer = link;
        const code = await link.transport.createInvite();
        const encoded = await encodeSignalLink(decodeSignal(code));
        return buildInviteLink(encoded, projectId, projectName);
      },
      async acceptInviteLink(code: string) {
        const link = openPeer();
        pendingOffer = null;
        const answer = await link.transport.acceptInvite(await toPlainCode(code));
        const encoded = await encodeSignalLink(decodeSignal(answer));
        return buildInviteLink(encoded, projectId, projectName, true);
      },
      stop() {
        bridge.stop();
        session.detach();
        for (const link of links) link.blobs.close();
        links.length = 0;
      },
    };
  })();

  runtimes.set(projectId, created);
  created.catch(() => runtimes.delete(projectId));
  return created;
}

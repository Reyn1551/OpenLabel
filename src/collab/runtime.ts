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
  buildRoomLink,
  decodeSignal,
  decodeSignalLink,
  encodeSignal,
  encodeSignalLink,
  lanAddressesFromSdp,
  newRoomId,
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
  /**
   * One-click link: the offer is published to this instance's LAN rendezvous,
   * so the other person never has to send an answer back.
   */
  createRoomLink(): Promise<string>;
  /** Joins the room named by a one-click link and posts the answer back. */
  joinRoom(room: string, host: string): Promise<void>;
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
  // Throwing keeps the hash in the wanted set: the metadata may simply have
  // replicated a moment after the bytes, and the retry will find the row.
  if (!image) throw new Error(`No image row for hash ${hash} yet.`);
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

    /**
     * Declares every image this device lacks, on every pair.
     *
     * `request` is idempotent and keeps the hash in a wanted set until the bytes
     * arrive, so calling this repeatedly is cheaper than tracking which pairs
     * were reachable at which moment.
     */
    const requestMissing = async (): Promise<void> => {
      const images = await listImages(projectId);
      for (const image of images) {
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
      // The link is referenced from its own transport events, which fire only
      // after the constructor returns, so the binding is assigned by then.
      const link: PeerLink = { transport: null as unknown as WebRtcTransport, blobs: null as unknown as BlobSync };
      const events: TransportEvents = {
        onOps: (ops, vv) => session.receive(ops, vv),
        onPeer: (peer, status) => {
          session.markPeer(peer, status === 'connected' ? 'connected' : 'pending');
          if (status !== 'connected') return;
          session.announce();
          // The channel is finally writable: flush every hash this device still
          // wants. Requests that raced the connection are not lost any more.
          link.blobs.onOpen();
          void requestMissing();
        },
        onControl: (raw) => handler?.(raw),
      };
      const transport = new WebRtcTransport(session.peer, events);
      const blobs = new BlobSync({
        peer: session.peer,
        send: (message) => transport.sendControl(message),
        read: readBlobByHash,
        received: (hash, blob) => storeIncomingBlob(hash, blob),
        // One peer may not hold every image; keep waiting on the others.
        onUnavailable: () => undefined,
      });
      handler = (raw) => {
        blobs.handle(raw);
      };
      link.transport = transport;
      link.blobs = blobs;
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
      async createRoomLink() {
        const link = openPeer();
        pendingOffer = link;
        const offer = await link.transport.createInvite();
        // Chrome hides local IPs behind mDNS names in the SDP, so the CLI is asked
        // for the machine's real interfaces instead. Fall back to the SDP's own
        // candidate only when the instance is not served by our CLI.
        const httpPort = window.location.port || '80';
        let addresses: string[] = [];
        try {
          const info = await fetch(`${window.location.origin}/__info`);
          if (info.ok) {
            const body = (await info.json()) as { addresses?: string[] };
            addresses = (body.addresses ?? []).map((address) => `${address}:${httpPort}`);
          }
        } catch {
          // Older instance or a static host; the SDP fallback below still applies.
        }
        if (addresses.length === 0) {
          addresses = lanAddressesFromSdp(decodeSignal(offer).sdp).map((entry) => {
            const [address, icePort] = entry.split(':');
            void icePort;
            return `${address}:${httpPort}`;
          });
        }
        if (addresses.length === 0) {
          throw new Error('This device has no LAN address; use the manual invite link instead.');
        }
        const host = addresses.join(',');
        const room = newRoomId();
        const origin = window.location.origin;
        const posted = await fetch(`${origin}/__signal/${room}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'offer', payload: offer }),
        });
        if (!posted.ok) throw new Error('This OpenLabel instance cannot host a pairing room.');

        // Poll for the guest's answer; the connection completes on its own.
        void (async () => {
          const deadline = Date.now() + 10 * 60 * 1000;
          while (Date.now() < deadline && pendingOffer === link) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            try {
              const response = await fetch(`${origin}/__signal/${room}?role=answer`);
              if (!response.ok) continue;
              const body = (await response.json()) as { payload?: string };
              if (!body.payload) continue;
              await link.transport.acceptAnswer(await toPlainCode(body.payload));
              return;
            } catch {
              // Keep waiting; the guest may not have opened the link yet.
            }
          }
        })();

        return buildRoomLink({ room, host, projectId, name: projectName });
      },
      async joinRoom(room: string, host: string) {
        const origin = window.location.origin;
        const ownAddress = `${window.location.hostname}:${window.location.port || '80'}`;
        // Try the host's advertised addresses, then this same instance. The
        // second candidate keeps a demo on one machine working, and covers the
        // case where the two devices reach each other through a shared address
        // rather than the interface the link happened to name.
        const relay = [host, ownAddress].filter(Boolean).join(',');
        const response = await fetch(`${origin}/__signal/${room}?role=offer&relay=${encodeURIComponent(relay)}`);
        if (!response.ok) throw new Error('The other device is not hosting this room any more.');
        const body = (await response.json()) as { payload?: string };
        if (!body.payload) throw new Error('The room has no offer yet.');

        const link = openPeer();
        pendingOffer = null;
        const answer = await link.transport.acceptInvite(await toPlainCode(body.payload));
        const posted = await fetch(`${origin}/__signal/${room}?relay=${encodeURIComponent(relay)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'answer', payload: answer }),
        });
        if (!posted.ok) throw new Error('Could not send the answer back to the host.');
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

/**
 * Two transports for the same op stream.
 *
 * `BroadcastTransport` is the zero-configuration default: tabs and windows of
 * one browser profile coordinate over `BroadcastChannel`. `WebRtcTransport`
 * extends that to peers on the same LAN without any server, using manually
 * exchanged offer/answer codes (see ./signaling) and host ICE candidates only.
 *
 * Both transports are dumb pipes: they frame ops, validate the envelope, and
 * hand them to the CRDT. Ordering, deduplication and convergence are the
 * reducer's job.
 */

import { decodeSignal, encodeSignal } from './signaling';
import type { Op, OpKind, PeerId, VersionVector } from './types';

export const DEFAULT_CHANNEL_NAME = 'openlabel-collab';
export const DATA_CHANNEL_LABEL = 'openlabel-collab';

/** Hard cap on one serialized frame; a batched sync must be split below this. */
export const MAX_FRAME_BYTES = 1024 * 1024;

const ICE_GATHERING_TIMEOUT_MS = 10_000;

const OP_KINDS: readonly OpKind[] = [
  'ann.put',
  'ann.del',
  'img.meta',
  'img.claim',
  'img.done',
  'class.put',
  'proj.put',
];

export interface TransportEvents {
  /** Called for every remote frame; `vv` is the sender's version vector. */
  onOps(ops: Op[], vv: VersionVector): void;
  /** Called when a remote peer becomes reachable or goes away. */
  onPeer(peer: PeerId, state: 'connected' | 'disconnected'): void;
  /** Called for a non-CRDT message, such as an image transfer chunk. */
  onControl?(raw: unknown): void;
}

/**
 * Public STUN servers only help a peer learn its own public address so the two
 * browsers can attempt a direct connection across NAT. No image, annotation, or
 * project data passes through them; if a direct path cannot be found the pair
 * simply fails to connect rather than falling back to a relay.
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

export interface Transport {
  send(ops: Op[], vv?: VersionVector): void;
  close(): void;
}

/** Wire envelope shared by both transports. */
export interface Frame {
  v: 1;
  from: PeerId;
  ops: Op[];
  vv: VersionVector;
}

function makeFrame(from: PeerId, ops: Op[], vv: VersionVector): Frame {
  return { v: 1, from, ops, vv };
}

function isOp(value: unknown): value is Op {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.oid !== 'string' || record.oid.length === 0) return false;
  if (typeof record.k !== 'string' || !OP_KINDS.includes(record.k as OpKind)) return false;
  const stamp = record.s as Record<string, unknown> | null;
  return (
    typeof stamp === 'object' &&
    stamp !== null &&
    typeof stamp.t === 'number' &&
    Number.isFinite(stamp.t) &&
    typeof stamp.p === 'string' &&
    stamp.p.length > 0
  );
}

function isVersionVector(value: unknown): value is VersionVector {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (counter) => typeof counter === 'number' && Number.isFinite(counter),
  );
}

/**
 * Validates an untrusted list of operations, e.g. one loaded from a sync file.
 * Returns `null` when any entry is malformed, so a bad file cannot half-apply.
 */
export function parseOps(value: unknown): Op[] | null {
  if (!Array.isArray(value) || !value.every(isOp)) return null;
  return value as Op[];
}

/**
 * Parse an untrusted wire payload.
 *
 * Returns `null` instead of throwing: frames arrive from a channel the peer
 * controls, and one malformed message must not tear down the handler.
 */
export function parseFrame(data: unknown): Frame | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;

  if (record.v !== 1) return null;
  if (typeof record.from !== 'string' || record.from.length === 0) return null;
  if (!Array.isArray(record.ops) || !record.ops.every(isOp)) return null;
  if (!isVersionVector(record.vv)) return null;

  return { v: 1, from: record.from, ops: record.ops as Op[], vv: record.vv };
}

function parseJsonFrame(raw: string): Frame | null {
  // Check the size before parsing so a hostile frame cannot force a huge parse.
  if (raw.length > MAX_FRAME_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseFrame(parsed);
}

/**
 * Same-profile transport: every tab of this browser profile shares a
 * `BroadcastChannel` name. `BroadcastChannel` has no membership event, so
 * `onPeer` is never called here: presence is derived from the CRDT state and
 * the version vectors each frame carries.
 */
export class BroadcastTransport implements Transport {
  readonly peerId: PeerId;

  private readonly channel: BroadcastChannel;
  private readonly events: TransportEvents;
  private closed = false;

  constructor(peerId: PeerId, events: TransportEvents, channelName = DEFAULT_CHANNEL_NAME) {
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error('BroadcastChannel is unavailable; this transport needs a browser tab context.');
    }
    this.peerId = peerId;
    this.events = events;
    this.channel = new BroadcastChannel(channelName);
    this.channel.onmessage = (event: MessageEvent) => this.handleFrame(event.data);
  }

  send(ops: Op[], vv: VersionVector = {}): void {
    if (this.closed) return;
    this.channel.postMessage(makeFrame(this.peerId, ops, vv));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.onmessage = null;
    this.channel.close();
  }

  private handleFrame(data: unknown): void {
    if (this.closed) return;
    const frame = parseFrame(data);
    // Our own frames are echoed by some implementations; never apply them twice.
    if (!frame || frame.from === this.peerId) return;
    this.events.onOps(frame.ops, frame.vv);
  }
}

/** Resolves once ICE gathering finished or the timeout elapsed, whichever is first. */
function waitForIceGathering(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.removeEventListener('icegatheringstatechange', onStateChange);
      connection.removeEventListener('icecandidate', onCandidate);
      resolve();
    };

    const onStateChange = (): void => {
      if (connection.iceGatheringState === 'complete') finish();
    };

    // A null candidate is the end-of-candidates signal in browsers that report
    // it before the gathering state flips.
    const onCandidate = (event: RTCPeerConnectionIceEvent): void => {
      if (!event.candidate) finish();
    };

    const timer = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
    connection.addEventListener('icegatheringstatechange', onStateChange);
    connection.addEventListener('icecandidate', onCandidate);
  });
}

/**
 * LAN transport: no ICE servers, so only host candidates are gathered and peers
 * on the same network connect without any infrastructure. Manual signaling must
 * complete before the data channel opens; frames sent earlier are dropped.
 */
export class WebRtcTransport implements Transport {
  readonly peerId: PeerId;

  private readonly events: TransportEvents;
  private readonly iceServers: RTCIceServer[];
  private connection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private remotePeer: PeerId | null = null;
  private closed = false;
  private connected = false;

  constructor(peerId: PeerId, events: TransportEvents, iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS) {
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('RTCPeerConnection is unavailable; this transport needs a browser tab context.');
    }
    this.peerId = peerId;
    this.events = events;
    this.iceServers = iceServers;
  }

  /** Initiator step 1: produce the offer code to hand to the other person. */
  async createInvite(): Promise<string> {
    if (this.dataChannel || this.connection?.localDescription) {
      throw new Error('This transport already has an invite in progress.');
    }
    const connection = this.ensureConnection();
    this.attachDataChannel(connection.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true }));

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIceGathering(connection);

    const description = connection.localDescription;
    if (!description?.sdp) throw new Error('Failed to create an offer: the local description is empty.');

    return encodeSignal({ v: 1, kind: 'offer', peer: this.peerId, sdp: description.sdp });
  }

  /** Responder step: accept an offer code and produce the answer code. */
  async acceptInvite(code: string): Promise<string> {
    if (this.connection?.localDescription) {
      throw new Error('This transport already created an offer; use acceptAnswer instead.');
    }
    const signal = decodeSignal(code);
    if (signal.kind !== 'offer') {
      throw new Error(`Expected an offer invite code, received a "${signal.kind}" code.`);
    }

    const connection = this.ensureConnection();
    this.remotePeer = signal.peer;
    connection.ondatachannel = (event: RTCDataChannelEvent) => this.attachDataChannel(event.channel);

    await connection.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await waitForIceGathering(connection);

    const description = connection.localDescription;
    if (!description?.sdp) throw new Error('Failed to create an answer: the local description is empty.');

    return encodeSignal({ v: 1, kind: 'answer', peer: this.peerId, sdp: description.sdp });
  }

  /** Initiator step 2: complete the connection with the returned answer code. */
  async acceptAnswer(code: string): Promise<void> {
    const signal = decodeSignal(code);
    if (signal.kind !== 'answer') {
      throw new Error(`Expected an answer invite code, received a "${signal.kind}" code.`);
    }
    const connection = this.connection;
    if (!connection || !connection.localDescription) {
      throw new Error('No pending invite: create an offer before accepting an answer.');
    }

    this.remotePeer = signal.peer;
    await connection.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    // `connected` is reported when the data channel opens, not when signaling ends.
  }

  send(ops: Op[], vv: VersionVector = {}): void {
    if (this.closed) return;
    const channel = this.dataChannel;
    if (!channel || channel.readyState !== 'open') return;
    channel.send(JSON.stringify(makeFrame(this.peerId, ops, vv)));
  }

  /**
   * Sends a non-CRDT control message and waits for the channel's buffer to
   * drain. Without the wait, a multi-megabyte image would queue faster than the
   * network can carry it and the data channel would close.
   */
  async sendControl(message: unknown): Promise<void> {
    const channel = this.dataChannel;
    if (this.closed || !channel || channel.readyState !== 'open') return;
    channel.send(JSON.stringify(message));
    while (!this.closed && channel.readyState === 'open' && channel.bufferedAmount > 512 * 1024) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    const channel = this.dataChannel;
    this.dataChannel = null;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onmessage = null;
      try {
        channel.close();
      } catch {
        // Already closing; nothing to release.
      }
    }

    const connection = this.connection;
    this.connection = null;
    if (connection) {
      connection.ondatachannel = null;
      connection.onconnectionstatechange = null;
      try {
        connection.close();
      } catch {
        // Already closing; nothing to release.
      }
    }

    this.markDisconnected();
  }

  private ensureConnection(): RTCPeerConnection {
    if (this.closed) throw new Error('Transport is closed.');
    if (this.connection) return this.connection;

    // Host candidates connect peers on one network; the configured STUN servers
    // add a public candidate so a direct path can also be found across NAT.
    const connection = new RTCPeerConnection({ iceServers: this.iceServers });
    connection.onconnectionstatechange = (): void => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
        this.markDisconnected();
      }
    };
    this.connection = connection;
    return connection;
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    channel.onopen = (): void => this.markConnected();
    channel.onclose = (): void => this.markDisconnected();
    channel.onmessage = (event: MessageEvent) => this.handleFrame(event.data);
    // The responder can receive a channel that is already open, in which case
    // `onopen` never fires and presence would stay pending forever.
    if (channel.readyState === 'open') this.markConnected();
  }

  private handleFrame(data: unknown): void {
    if (this.closed || typeof data !== 'string') return;
    const frame = parseJsonFrame(data);
    if (!frame) {
      // Not a CRDT frame: blob transfer and future control messages live here.
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      this.events.onControl?.(parsed);
      return;
    }
    if (frame.from === this.peerId) return;

    // The remote peer id is only known once signaling (or the first frame) says so.
    if (!this.remotePeer) this.remotePeer = frame.from;
    // One peer connection carries exactly one remote replica.
    if (frame.from !== this.remotePeer) return;
    this.markConnected();
    this.events.onOps(frame.ops, frame.vv);
  }

  private markConnected(): void {
    if (this.closed || this.connected || !this.remotePeer) return;
    this.connected = true;
    this.events.onPeer(this.remotePeer, 'connected');
  }

  private markDisconnected(): void {
    const peer = this.remotePeer;
    if (!peer || !this.connected) return;
    this.connected = false;
    this.events.onPeer(peer, 'disconnected');
  }
}
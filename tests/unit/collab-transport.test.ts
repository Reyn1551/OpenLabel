// @vitest-environment node
//
// Node environment on purpose: `BroadcastChannel` is a Node global and the
// transport code is meant to be import-safe outside a browser. WebRTC itself is
// not exercised here — jsdom/Node have no RTCPeerConnection and no real network,
// so the tests only prove that importing `transport.ts` touches no browser
// global and that constructing `WebRtcTransport` fails with a descriptive error.
// The offer/answer flow needs two real browsers to be verified.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeSignal, encodeSignal, MAX_SIGNAL_BYTES, type Signal } from '@/collab/signaling';
import {
  BroadcastTransport,
  parseFrame,
  WebRtcTransport,
  type Frame,
  type Transport,
  type TransportEvents,
} from '@/collab/transport';
import type { Op, VersionVector } from '@/collab/types';

const PEER_A = '0123456789abcdef';
const PEER_B = 'fedcba9876543210';
const PEER_C = '1111111111111111';

function makeOp(oid: string, author = PEER_A): Op {
  return {
    oid,
    k: 'img.done',
    s: { t: 1, p: author },
    image: 'a'.repeat(64),
    done: true,
  };
}

/** Hand-rolled encoder so tests can produce payloads `encodeSignal` would refuse. */
function rawCode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `OL1.${btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')}`;
}

function makeEvents() {
  const frames: Array<{ ops: Op[]; vv: VersionVector }> = [];
  const peers: string[] = [];
  const events: TransportEvents = {
    onOps(ops, vv) {
      frames.push({ ops, vv });
    },
    onPeer(peer, state) {
      peers.push(`${peer}:${state}`);
    },
  };
  return { events, frames, peers };
}

function uniqueChannel(label: string): string {
  return `openlabel-test-${label}-${Math.random().toString(36).slice(2)}`;
}

const openTransports: Transport[] = [];

afterEach(() => {
  while (openTransports.length > 0) openTransports.pop()?.close();
});

function track<T extends Transport>(transport: T): T {
  openTransports.push(transport);
  return transport;
}

describe('signaling codec', () => {
  it('round-trips an offer and an answer', () => {
    const offer: Signal = {
      v: 1,
      kind: 'offer',
      peer: PEER_A,
      sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=ice-ufrag:abc\r\n',
    };
    const answer: Signal = { v: 1, kind: 'answer', peer: PEER_B, sdp: 'v=0\r\no=- 3 4 IN IP4 10.0.0.2\r\n' };

    for (const signal of [offer, answer]) {
      const code = encodeSignal(signal);
      expect(code.startsWith('OL1.')).toBe(true);
      expect(code).not.toContain('=');
      expect(code).not.toContain('+');
      expect(code).not.toContain('/');
      expect(decodeSignal(code)).toEqual(signal);
    }
  });

  it('tolerates whitespace introduced while copying the code by hand', () => {
    const signal: Signal = { v: 1, kind: 'offer', peer: PEER_A, sdp: 'v=0\r\n' };
    const code = encodeSignal(signal);
    const wrapped = `${code.slice(0, 20)}\n  ${code.slice(20)}\n`;

    expect(decodeSignal(wrapped)).toEqual(signal);
  });

  it('rejects a wrong prefix', () => {
    const code = encodeSignal({ v: 1, kind: 'offer', peer: PEER_A, sdp: 'v=0\r\n' });
    expect(() => decodeSignal(code.replace('OL1.', 'OL2.'))).toThrow(/prefix/u);
    expect(() => decodeSignal('hello')).toThrow(/prefix/u);
  });

  it('rejects a wrong version', () => {
    expect(() => decodeSignal(rawCode({ v: 2, kind: 'offer', peer: PEER_A, sdp: 'v=0\r\n' }))).toThrow(
      /version/u,
    );
    expect(() => decodeSignal(rawCode({ kind: 'offer', peer: PEER_A, sdp: 'v=0\r\n' }))).toThrow(
      /version/u,
    );
  });

  it('rejects truncated JSON', () => {
    const longCode = encodeSignal({
      v: 1,
      kind: 'offer',
      peer: PEER_A,
      sdp: 'v=0\r\na=candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host\r\n'.repeat(10),
    });
    // Cutting a copied code mid-payload leaves base64 that decodes to half a JSON object.
    const cut = longCode.slice(0, Math.floor(longCode.length * 0.6));
    expect(() => decodeSignal(cut)).toThrow(/JSON/u);

    const brokenJson = `OL1.${btoa('{"v":1,"kind":"offer","peer":"a","sdp":"b"')
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/u, '')}`;
    expect(() => decodeSignal(brokenJson)).toThrow(/JSON/u);
  });

  it('rejects an oversized payload', () => {
    const oversized: Signal = {
      v: 1,
      kind: 'offer',
      peer: PEER_A,
      sdp: 'x'.repeat(MAX_SIGNAL_BYTES),
    };
    expect(() => encodeSignal(oversized)).toThrow(/exceeds/u);

    // Built by hand because `encodeSignal` refuses the same payload.
    expect(() => decodeSignal(rawCode(oversized))).toThrow(/exceeds/u);
  });

  it('rejects a payload that is JSON but not a signal', () => {
    expect(() => decodeSignal(rawCode([1, 2, 3]))).toThrow(/object/u);
    expect(() => decodeSignal(rawCode({ v: 1, kind: 'candidate', peer: PEER_A, sdp: 'v=0' }))).toThrow(
      /kind/u,
    );
    expect(() => decodeSignal(rawCode({ v: 1, kind: 'offer', peer: '', sdp: 'v=0' }))).toThrow(/peer/u);
    expect(() => decodeSignal(rawCode({ v: 1, kind: 'offer', peer: PEER_A }))).toThrow(/sdp/u);
    expect(() => decodeSignal('OL1.$$$$')).toThrow(/base64url/u);
    expect(() => decodeSignal('OL1.')).toThrow(/empty/u);
  });
});

describe('BroadcastTransport', () => {
  it('delivers ops between two instances of the same profile', async () => {
    const channel = uniqueChannel('delivery');
    const a = makeEvents();
    const b = makeEvents();
    const initiator = track(new BroadcastTransport(PEER_A, a.events, channel));
    track(new BroadcastTransport(PEER_B, b.events, channel));

    const ops = [makeOp('op-1')];
    const vv: VersionVector = { [PEER_A]: 3 };
    initiator.send(ops, vv);

    await vi.waitFor(() => expect(b.frames).toHaveLength(1));
    expect(b.frames[0]?.ops).toEqual(ops);
    expect(b.frames[0]?.vv).toEqual(vv);
    expect(a.frames).toHaveLength(0);
  });

  it('delivers a reply back to the first instance', async () => {
    const channel = uniqueChannel('reply');
    const a = makeEvents();
    const b = makeEvents();
    const first = track(new BroadcastTransport(PEER_A, a.events, channel));
    const second = track(new BroadcastTransport(PEER_B, b.events, channel));

    first.send([makeOp('op-1')]);
    await vi.waitFor(() => expect(b.frames).toHaveLength(1));

    const reply = [makeOp('op-2', PEER_B)];
    second.send(reply, { [PEER_B]: 7 });
    await vi.waitFor(() => expect(a.frames).toHaveLength(1));
    expect(a.frames[0]?.ops).toEqual(reply);
    expect(b.frames).toHaveLength(1);
  });

  it('ignores its own frames', async () => {
    const channel = uniqueChannel('self');
    const solo = makeEvents();
    const witness = makeEvents();
    const soloTransport = track(new BroadcastTransport(PEER_A, solo.events, channel));
    track(new BroadcastTransport(PEER_B, witness.events, channel));

    soloTransport.send([makeOp('own-1')], { [PEER_A]: 1 });

    // Once the witness has the frame, a self-delivery would already have run too.
    await vi.waitFor(() => expect(witness.frames).toHaveLength(1));
    expect(solo.frames).toHaveLength(0);
    expect(solo.peers).toHaveLength(0);
  });

  it('ignores malformed frames instead of throwing', async () => {
    const channel = uniqueChannel('malformed');
    const events = makeEvents();
    track(new BroadcastTransport(PEER_A, events.events, channel));

    const hostile = new BroadcastChannel(channel);
    hostile.postMessage('not json');
    hostile.postMessage({ v: 2, from: PEER_B, ops: [], vv: {} });
    hostile.postMessage({ v: 1, from: PEER_B, ops: [{ nope: true }], vv: {} });
    hostile.postMessage({ v: 1, from: PEER_B, ops: [], vv: { [PEER_B]: 'x' } });
    // A well-formed frame sent last is the proof the earlier ones were consumed.
    hostile.postMessage({ v: 1, from: PEER_B, ops: [makeOp('valid', PEER_B)], vv: { [PEER_B]: 1 } });

    await vi.waitFor(() => expect(events.frames).toHaveLength(1));
    hostile.close();
    expect(events.frames[0]?.ops).toEqual([makeOp('valid', PEER_B)]);
  });

  it('stops sending and receiving after close()', async () => {
    const channel = uniqueChannel('close');
    const closed = makeEvents();
    const witness = makeEvents();
    const closedTransport = new BroadcastTransport(PEER_A, closed.events, channel);
    const sender = track(new BroadcastTransport(PEER_B, makeEvents().events, channel));
    track(new BroadcastTransport(PEER_C, witness.events, channel));

    closedTransport.close();
    expect(() => closedTransport.send([makeOp('after-close')])).not.toThrow();
    sender.send([makeOp('still-open', PEER_B)]);

    // The witness proves the frame was broadcast; a still-open channel at the
    // same address would have received it too.
    await vi.waitFor(() => expect(witness.frames).toHaveLength(1));
    expect(closed.frames).toHaveLength(0);
  });
});

describe('WebRtcTransport', () => {
  it('is import-safe and fails with a descriptive error outside a browser', () => {
    const events = makeEvents();
    // No RTCPeerConnection global exists in Node; the constructor must say so.
    expect(() => new WebRtcTransport(PEER_A, events.events)).toThrow(/RTCPeerConnection/u);
    expect(typeof WebRtcTransport.prototype.createInvite).toBe('function');
    expect(typeof WebRtcTransport.prototype.acceptInvite).toBe('function');
    expect(typeof WebRtcTransport.prototype.acceptAnswer).toBe('function');
  });
});

describe('frame validation', () => {
  it('accepts the shared envelope and rejects malformed payloads', () => {
    const frame: Frame = { v: 1, from: PEER_A, ops: [makeOp('op-1')], vv: { [PEER_A]: 1 } };
    expect(parseFrame(frame)).toEqual(frame);

    expect(parseFrame(null)).toBeNull();
    expect(parseFrame({ ...frame, v: 2 })).toBeNull();
    expect(parseFrame({ ...frame, from: '' })).toBeNull();
    expect(parseFrame({ ...frame, ops: 'nope' })).toBeNull();
    expect(parseFrame({ ...frame, ops: [{ oid: 'x', k: 'unknown', s: { t: 1, p: PEER_A } }] })).toBeNull();
    expect(parseFrame({ ...frame, ops: [{ oid: 'x', k: 'img.done', s: { t: 'x' } }] })).toBeNull();
    expect(parseFrame({ ...frame, vv: null })).toBeNull();
    expect(parseFrame({ ...frame, vv: { [PEER_A]: Number.NaN } })).toBeNull();
  });
});
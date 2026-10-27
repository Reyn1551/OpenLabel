// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BroadcastTransport, type TransportEvents } from '@/collab/transport';
import { applyOps, emptyState, materialize, opsSince, versionVector } from '@/collab/state';
import type { CollabState } from '@/collab/state';
import type { Op, SyncAnnotation } from '@/collab/types';

/**
 * Two replicas exchanging real frames over a real BroadcastChannel.
 *
 * This covers the wire path end to end (encode → channel → parse → merge).
 * Delivery is awaited per condition instead of a fixed sleep, so a slow CI box
 * cannot turn a correct merge into a flake.
 */

function annotation(id: string, cls: string, createdAt: number): SyncAnnotation {
  return {
    id,
    classId: cls,
    geometry: { kind: 'bbox', x: 1, y: 2, width: 3, height: 4 },
    attributes: {},
    source: 'human',
    author: 'peer',
    createdAt,
    updatedAt: createdAt,
  };
}

interface Peer {
  state: CollabState;
  log: Op[];
  transport: BroadcastTransport;
}

let channelCounter = 0;

function makePeer(peerId: string, channel: string): Peer {
  const peer: Peer = { state: emptyState(), log: [], transport: null as unknown as BroadcastTransport };
  const events: TransportEvents = {
    onOps: (ops, vv) => {
      const fresh = ops.filter((op) => !peer.log.some((existing) => existing.oid === op.oid));
      peer.log = peer.log.concat(fresh);
      peer.state = applyOps(peer.state, ops);
      const missing = opsSince(peer.log, vv);
      if (missing.length > 0) peer.transport.send(missing, versionVector(peer.state));
    },
    onPeer: () => {},
  };
  peer.transport = new BroadcastTransport(peerId, events, channel);
  return peer;
}

const idsAt = (peer: Peer, image: string) =>
  (materialize(peer.state).annotationsByImage.get(image) ?? []).map((entry) => entry.id);

beforeEach(() => {
  channelCounter += 1;
});

describe('transport + CRDT convergence', () => {
  it('merges concurrent annotations from two peers regardless of arrival order', async () => {
    const channel = `openlabel-test-${channelCounter}`;
    const a = makePeer('aaaaaaaaaaaaaaaa', channel);
    const b = makePeer('bbbbbbbbbbbbbbbb', channel);

    a.transport.send([
      { oid: 'a:1:ann.put', k: 'ann.put', s: { t: 1, p: 'aaaaaaaaaaaaaaaa' }, image: 'img1', ann: annotation('ann-1', 'car', 1) },
    ]);
    b.transport.send([
      { oid: 'b:1:ann.put', k: 'ann.put', s: { t: 1, p: 'bbbbbbbbbbbbbbbb' }, image: 'img1', ann: annotation('ann-2', 'car', 2) },
    ]);

    await vi.waitFor(() => {
      expect(idsAt(a, 'img1')).toEqual(['ann-1', 'ann-2']);
      expect(idsAt(b, 'img1')).toEqual(['ann-1', 'ann-2']);
    });

    a.transport.close();
    b.transport.close();
  });

  it('backfills a late joiner from the peer operation log', async () => {
    const channel = `openlabel-test-${channelCounter}`;
    const a = makePeer('aaaaaaaaaaaaaaaa', channel);

    for (let index = 1; index <= 5; index += 1) {
      a.log.push({
        oid: `a:${index}:ann.put`,
        k: 'ann.put',
        s: { t: index, p: 'aaaaaaaaaaaaaaaa' },
        image: 'img1',
        ann: annotation(`ann-${index}`, 'car', index),
      });
    }
    a.state = applyOps(a.state, a.log);

    const b = makePeer('bbbbbbbbbbbbbbbb', channel);
    // A peer with nothing announces its (empty) version vector.
    b.transport.send([], versionVector(b.state));

    await vi.waitFor(() => {
      expect(idsAt(b, 'img1')).toHaveLength(5);
      expect(versionVector(b.state)).toMatchObject({ aaaaaaaaaaaaaaaa: 5 });
    });

    a.transport.close();
    b.transport.close();
  });

  it('keeps claims and review state convergent', async () => {
    const channel = `openlabel-test-${channelCounter}`;
    const a = makePeer('aaaaaaaaaaaaaaaa', channel);
    const b = makePeer('bbbbbbbbbbbbbbbb', channel);

    b.transport.send([
      { oid: 'b:1:img.claim', k: 'img.claim', s: { t: 1, p: 'bbbbbbbbbbbbbbbb' }, image: 'img9', owner: 'bbbbbbbbbbbbbbbb' },
      { oid: 'b:2:img.done', k: 'img.done', s: { t: 2, p: 'bbbbbbbbbbbbbbbb' }, image: 'img9', done: true },
    ]);
    await vi.waitFor(() => {
      expect(materialize(a.state).claims.get('img9')).toBe('bbbbbbbbbbbbbbbb');
      expect(materialize(a.state).done.get('img9')).toBe(true);
    });

    // A release later in the total order wins on both replicas.
    a.transport.send([
      { oid: 'a:3:img.claim', k: 'img.claim', s: { t: 3, p: 'aaaaaaaaaaaaaaaa' }, image: 'img9', owner: null },
    ]);
    await vi.waitFor(() => {
      expect(materialize(a.state).claims.get('img9')).toBeNull();
      expect(materialize(b.state).claims.get('img9')).toBeNull();
    });

    a.transport.close();
    b.transport.close();
  });
});
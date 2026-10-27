import { describe, expect, it } from 'vitest';
import { applyOps, emptyState, materialize } from '@/collab/state';
import type { CollabState } from '@/collab/state';
import { mulberry32 } from '@/autolabel/features';
import type { Op, PeerId } from '@/collab/types';

/**
 * The stated target workload: one team, 5 000 images, five annotators.
 *
 * Each annotator claims one fifth of the images and the ops are applied to every
 * replica in a different shuffled order. Convergence must not depend on arrival
 * order, and the claim split must stay exactly 1 000 per person.
 */

const IMAGES = 5000;
const PEERS: PeerId[] = ['0000000000000001', '0000000000000002', '0000000000000003', '0000000000000004', '0000000000000005'];

function imageKey(index: number): string {
  return index.toString(16).padStart(64, '0');
}

function buildOps(): Op[] {
  const ops: Op[] = [];
  for (let index = 0; index < IMAGES; index += 1) {
    const image = imageKey(index);
    const owner = PEERS[index % PEERS.length];
    // Metadata is authored by the dataset owner, claims by the assignee.
    ops.push({
      oid: `${PEERS[0]}:${index}:img.meta`,
      k: 'img.meta',
      s: { t: index, p: PEERS[0] },
      image,
      meta: { name: `img-${index}.jpg`, width: 1024, height: 768, bytes: 2048, mime: 'image/jpeg', createdAt: index, tags: [] },
    });
    ops.push({
      oid: `${owner}:${index}:img.claim`,
      k: 'img.claim',
      s: { t: index + 1, p: owner },
      image,
      owner,
    });
  }
  return ops;
}

function shuffle<T>(items: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rand() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function countsByOwner(state: CollabState): Map<PeerId, number> {
  const counts = new Map<PeerId, number>();
  for (const owner of materialize(state).claims.values()) {
    if (!owner) continue;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return counts;
}

describe('five annotators, five thousand images', () => {
  it('converges to the same split on every replica regardless of apply order', () => {
    const ops = buildOps();
    expect(ops).toHaveLength(IMAGES * 2);

    const replicas = PEERS.map((_, index) => applyOps(emptyState(), shuffle(ops, 17 + index)));

    const reference = replicas[0];
    const referenceClaims = materialize(reference).claims;
    expect(referenceClaims.size).toBe(IMAGES);
    expect(materialize(reference).images.size).toBe(IMAGES);

    for (const peer of PEERS) {
      expect(countsByOwner(reference).get(peer)).toBe(IMAGES / PEERS.length);
    }

    for (let index = 1; index < replicas.length; index += 1) {
      const claims = materialize(replicas[index]).claims;
      expect(claims.size).toBe(referenceClaims.size);
      for (const [image, owner] of referenceClaims) {
        expect(claims.get(image)).toBe(owner);
      }
      expect(replicas[index].vv).toEqual(reference.vv);
    }
  });
});
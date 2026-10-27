import { describe, expect, it } from 'vitest';
import { LamportClock, randomPeerId } from '@/collab/clock';
import {
  applyOp,
  applyOps,
  emptyState,
  materialize,
  opsSince,
  versionVector,
} from '@/collab/state';
import type {
  ImageKey,
  Op,
  Stamp,
  SyncAnnotation,
  SyncClass,
  SyncImageMeta,
  SyncProject,
} from '@/collab/types';

const IMG_A: ImageKey = 'a'.repeat(64);
const IMG_B: ImageKey = 'b'.repeat(64);
const IMG_C: ImageKey = 'c'.repeat(64);

function ann(id: string, createdAt: number, overrides: Partial<SyncAnnotation> = {}): SyncAnnotation {
  return {
    id,
    classId: 'c1',
    geometry: { kind: 'bbox', x: 0, y: 0, width: 10, height: 10 },
    attributes: {},
    source: 'human',
    author: 'p1',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function cls(id: string, name: string): SyncClass {
  return { id, name, color: '#336699' };
}

function meta(name: string, createdAt: number): SyncImageMeta {
  return {
    name,
    width: 640,
    height: 480,
    bytes: 1024,
    mime: 'image/jpeg',
    createdAt,
    tags: [],
  };
}

const project: SyncProject = {
  name: 'fixture',
  type: 'object-detection',
  description: '',
  classes: [cls('c1', 'bolt')],
  split: { train: 70, valid: 20, test: 10 },
};

/** Scenario mixing writes, deletes, resurrections, and a permanently stale put. */
const scenario: Op[] = [
  { oid: 'p1:1', k: 'ann.put', s: { p: 'p1', t: 1 }, image: IMG_A, ann: ann('a-early', 10) },
  { oid: 'p1:2', k: 'ann.put', s: { p: 'p1', t: 2 }, image: IMG_A, ann: ann('a-late', 30) },
  { oid: 'p2:1', k: 'ann.put', s: { p: 'p2', t: 1 }, image: IMG_A, ann: ann('a-mid', 20) },
  { oid: 'p2:2', k: 'ann.del', s: { p: 'p2', t: 2 }, image: IMG_A, id: 'a-mid' },
  { oid: 'p1:3', k: 'img.claim', s: { p: 'p1', t: 3 }, image: IMG_A, owner: 'p1' },
  { oid: 'p2:3', k: 'img.claim', s: { p: 'p2', t: 3 }, image: IMG_A, owner: 'p2' },
  { oid: 'p3:1', k: 'img.meta', s: { p: 'p3', t: 1 }, image: IMG_A, meta: meta('first', 100) },
  { oid: 'p3:2', k: 'class.put', s: { p: 'p3', t: 2 }, cls: cls('c2', 'gear') },
  { oid: 'p1:4', k: 'img.done', s: { p: 'p1', t: 4 }, image: IMG_A, done: true },
  { oid: 'p2:4', k: 'ann.put', s: { p: 'p2', t: 4 }, image: IMG_A, ann: ann('a-early', 10, { updatedAt: 40 }) },
  { oid: 'p3:3', k: 'proj.put', s: { p: 'p3', t: 3 }, project },
  { oid: 'p1:5', k: 'class.put', s: { p: 'p1', t: 5 }, cls: cls('c1', 'bolt') },
  { oid: 'p2:5', k: 'img.meta', s: { p: 'p2', t: 5 }, image: IMG_A, meta: meta('newest', 120) },
  { oid: 'p3:4', k: 'ann.del', s: { p: 'p3', t: 4 }, image: IMG_B, id: 'b-1' },
  { oid: 'p4:1', k: 'ann.put', s: { p: 'p4', t: 1 }, image: IMG_B, ann: ann('b-1', 5) },
  { oid: 'p4:2', k: 'ann.put', s: { p: 'p4', t: 6 }, image: IMG_B, ann: ann('b-1', 6) },
  { oid: 'p2:6', k: 'img.meta', s: { p: 'p2', t: 6 }, image: IMG_C, meta: meta('third', 50) },
];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('LamportClock', () => {
  it('ticks monotonically, absorbs remote stamps, and derives stable op ids', () => {
    const clock = new LamportClock('aa');
    expect(clock.tick()).toEqual({ t: 1, p: 'aa' });
    clock.observe({ t: 9, p: 'bb' });
    expect(clock.tick()).toEqual({ t: 10, p: 'aa' });
    clock.observe({ t: 3, p: 'cc' });
    expect(clock.time).toBe(10);

    const stamp = clock.tick();
    expect(clock.nextOpId('ann.put', stamp)).toBe('aa:11:ann.put');
    expect(clock.nextOpId('ann.put', stamp)).toBe('aa:11:ann.put');
  });

  it('mints 16 lowercase hex peer ids without collisions', () => {
    const ids = new Set(Array.from({ length: 32 }, () => randomPeerId()));
    expect(ids.size).toBe(32);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('convergence', () => {
  it('materializes identically for every replay order of the same op set', () => {
    const seeded = applyOps(emptyState(), scenario);
    const expected = materialize(seeded);
    const expectedVv = versionVector(seeded);

    expect(expected.annotationsByImage.get(IMG_A)?.map((a) => a.id)).toEqual(['a-early', 'a-late']);
    expect(expected.annotationsByImage.get(IMG_B)?.map((a) => a.id)).toEqual(['b-1']);
    expect(expected.annotationsByImage.get(IMG_A)?.[0]?.updatedAt).toBe(40);
    expect(expected.claims.get(IMG_A)).toBe('p2');
    expect(expected.done.get(IMG_A)).toBe(true);
    expect(expected.images.get(IMG_A)?.name).toBe('newest');
    expect([...expected.images.keys()]).toEqual([IMG_A, IMG_C]);
    expect(expected.classes.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(expected.project?.name).toBe('fixture');
    expect(expectedVv).toEqual({ p1: 5, p2: 6, p3: 4, p4: 6 });

    const rand = mulberry32(0x5eed);
    for (let round = 0; round < 60; round += 1) {
      const state = applyOps(emptyState(), shuffled(scenario, rand));
      expect(materialize(state)).toEqual(expected);
      expect(versionVector(state)).toEqual(expectedVv);
    }
  });

  it('observe then tick produces stamps greater than every observed stamp', () => {
    const clock = new LamportClock('aa');
    const remote: Stamp = { t: 4, p: 'zz' };
    clock.observe(remote);
    const local = clock.tick();
    expect(local.t).toBeGreaterThan(remote.t);
  });
});

describe('idempotency', () => {
  it('rejects duplicates by op id without changing materialized state', () => {
    const once = applyOps(emptyState(), scenario);
    const twice = applyOps(once, scenario);
    expect(materialize(twice)).toEqual(materialize(once));
    expect(versionVector(twice)).toEqual(versionVector(once));

    const duplicatedBatch = applyOps(emptyState(), [...scenario, ...scenario]);
    expect(materialize(duplicatedBatch)).toEqual(materialize(once));
    expect(versionVector(duplicatedBatch)).toEqual(versionVector(once));

    const state = emptyState();
    expect(applyOp(state, scenario[0])).toBe(true);
    expect(applyOp(state, scenario[0])).toBe(false);

    // Same oid with a different payload is still the same operation.
    const forged: Op = {
      oid: 'p1:1',
      k: 'ann.put',
      s: { p: 'p1', t: 1 },
      image: IMG_A,
      ann: ann('a-early', 999),
    };
    expect(applyOp(state, forged)).toBe(false);
    expect(materialize(state).annotationsByImage.get(IMG_A)?.[0]?.createdAt).toBe(10);
  });
});

describe('last-writer-wins', () => {
  const olderAnn = ann('x', 1, { attributes: { rev: 'old' } });
  const newerAnn = ann('x', 2, { attributes: { rev: 'new' } });

  it('never lets an older counter overwrite a newer one, regardless of arrival order', () => {
    const oldOp: Op = { oid: 'old', k: 'ann.put', s: { t: 4, p: 'zz' }, image: IMG_A, ann: olderAnn };
    const newOp: Op = { oid: 'new', k: 'ann.put', s: { t: 5, p: 'aa' }, image: IMG_A, ann: newerAnn };

    const forward = applyOps(emptyState(), [oldOp, newOp]);
    const reverse = applyOps(emptyState(), [newOp, oldOp]);
    expect(materialize(forward)).toEqual(materialize(reverse));
    expect(materialize(forward).annotationsByImage.get(IMG_A)?.[0]?.attributes.rev).toBe('new');

    const state = applyOps(emptyState(), [newOp]);
    expect(applyOp(state, oldOp)).toBe(false);
    expect(materialize(state).annotationsByImage.get(IMG_A)?.[0]?.attributes.rev).toBe('new');
  });

  it('breaks equal counters lexicographically by peer id', () => {
    const lower: Op = { oid: 'lower', k: 'ann.put', s: { t: 5, p: 'bb' }, image: IMG_A, ann: olderAnn };
    const higher: Op = { oid: 'higher', k: 'ann.put', s: { t: 5, p: 'cc' }, image: IMG_A, ann: newerAnn };

    const lowerFirst = applyOps(emptyState(), [lower, higher]);
    const higherFirst = applyOps(emptyState(), [higher, lower]);
    expect(materialize(lowerFirst)).toEqual(materialize(higherFirst));
    expect(materialize(lowerFirst).annotationsByImage.get(IMG_A)?.[0]?.attributes.rev).toBe('new');

    const state = applyOps(emptyState(), [higher]);
    expect(applyOp(state, lower)).toBe(false);
  });

  it('releases a claim with a newer null-owner op', () => {
    const claim: Op = {
      oid: 'claim',
      k: 'img.claim',
      s: { t: 2, p: 'aa' },
      image: IMG_A,
      owner: 'aa',
    };
    const release: Op = {
      oid: 'release',
      k: 'img.claim',
      s: { t: 3, p: 'bb' },
      image: IMG_A,
      owner: null,
    };

    const released = applyOps(emptyState(), [claim, release]);
    expect(materialize(released).claims.get(IMG_A)).toBeNull();

    const reverse = applyOps(emptyState(), [release, claim]);
    expect(materialize(reverse)).toEqual(materialize(released));
    expect(applyOp(released, claim)).toBe(false);
  });

  it('drops a stale img.meta instead of overwriting the newer metadata', () => {
    const newMeta: Op = {
      oid: 'meta-new',
      k: 'img.meta',
      s: { t: 8, p: 'aa' },
      image: IMG_A,
      meta: meta('new-name', 200),
    };
    const oldMeta: Op = {
      oid: 'meta-old',
      k: 'img.meta',
      s: { t: 7, p: 'zz' },
      image: IMG_A,
      meta: meta('old-name', 100),
    };

    const state = applyOps(emptyState(), [newMeta]);
    expect(applyOp(state, oldMeta)).toBe(false);
    expect(materialize(state).images.get(IMG_A)?.name).toBe('new-name');

    const forward = applyOps(emptyState(), [oldMeta, newMeta]);
    const reverse = applyOps(emptyState(), [newMeta, oldMeta]);
    expect(materialize(forward)).toEqual(materialize(reverse));
    expect(materialize(reverse).images.get(IMG_A)?.name).toBe('new-name');
  });
});

describe('deletes', () => {
  const put: Op = { oid: 'put', k: 'ann.put', s: { t: 2, p: 'aa' }, image: IMG_A, ann: ann('x', 1) };
  const del: Op = { oid: 'del', k: 'ann.del', s: { t: 3, p: 'bb' }, image: IMG_A, id: 'x' };

  it('records a tombstone that survives a later stale put', () => {
    const deleted = applyOps(emptyState(), [put, del]);
    expect(materialize(deleted).annotationsByImage.get(IMG_A) ?? []).toEqual([]);

    const stalePut: Op = {
      oid: 'stale-put',
      k: 'ann.put',
      s: { t: 2, p: 'cc' },
      image: IMG_A,
      ann: ann('x', 99),
    };
    expect(applyOp(deleted, stalePut)).toBe(false);
    expect(materialize(deleted).annotationsByImage.get(IMG_A) ?? []).toEqual([]);

    // A delete can arrive before the annotation it removes; the tombstone still holds.
    const deleteFirst = applyOps(emptyState(), [del]);
    expect(applyOp(deleteFirst, stalePut)).toBe(false);
    expect(materialize(deleteFirst).annotationsByImage.get(IMG_A) ?? []).toEqual([]);
  });

  it('resurrects an annotation when a newer put arrives', () => {
    const deleted = applyOps(emptyState(), [put, del]);
    const resurrect: Op = {
      oid: 'resurrect',
      k: 'ann.put',
      s: { t: 4, p: 'cc' },
      image: IMG_A,
      ann: ann('x', 5),
    };
    expect(applyOp(deleted, resurrect)).toBe(true);
    expect(materialize(deleted).annotationsByImage.get(IMG_A)?.map((a) => a.id)).toEqual(['x']);

    const staleDelete: Op = { oid: 'stale-del', k: 'ann.del', s: { t: 3, p: 'dd' }, image: IMG_A, id: 'x' };
    expect(applyOp(deleted, staleDelete)).toBe(false);
    expect(materialize(deleted).annotationsByImage.get(IMG_A)?.map((a) => a.id)).toEqual(['x']);
  });
});

describe('materialize ordering', () => {
  it('sorts image metadata by image key, not by arrival order', () => {
    const firstC: Op = {
      oid: 'meta-c',
      k: 'img.meta',
      s: { t: 1, p: 'aa' },
      image: IMG_C,
      meta: meta('c', 1),
    };
    const laterA: Op = {
      oid: 'meta-a',
      k: 'img.meta',
      s: { t: 2, p: 'aa' },
      image: IMG_A,
      meta: meta('a', 2),
    };
    const state = applyOps(emptyState(), [firstC, laterA]);
    expect([...materialize(state).images.keys()]).toEqual([IMG_A, IMG_C]);
  });

  it('sorts annotations by createdAt then id, independent of arrival order', () => {
    const b: Op = { oid: 'b', k: 'ann.put', s: { t: 1, p: 'aa' }, image: IMG_A, ann: ann('b', 10) };
    const a: Op = { oid: 'a', k: 'ann.put', s: { t: 2, p: 'aa' }, image: IMG_A, ann: ann('a', 10) };
    const c: Op = { oid: 'c', k: 'ann.put', s: { t: 3, p: 'aa' }, image: IMG_A, ann: ann('c', 5) };

    for (const order of [
      [b, a, c],
      [c, b, a],
      [a, c, b],
    ] as Op[][]) {
      const ids = materialize(applyOps(emptyState(), order)).annotationsByImage.get(IMG_A)?.map((x) => x.id);
      expect(ids).toEqual(['c', 'a', 'b']);
    }
  });
});

describe('version vectors', () => {
  it('filters unseen operations per author while preserving log order', () => {
    const log: Op[] = [
      { oid: 'p1:1', k: 'ann.put', s: { t: 1, p: 'p1' }, image: IMG_A, ann: ann('one', 1) },
      { oid: 'p2:1', k: 'ann.put', s: { t: 1, p: 'p2' }, image: IMG_A, ann: ann('two', 2) },
      { oid: 'p1:3', k: 'img.claim', s: { t: 3, p: 'p1' }, image: IMG_A, owner: 'p1' },
      { oid: 'p2:4', k: 'img.done', s: { t: 4, p: 'p2' }, image: IMG_A, done: true },
      { oid: 'p3:2', k: 'class.put', s: { t: 2, p: 'p3' }, cls: cls('c1', 'bolt') },
    ];

    expect(opsSince(log, {}).map((op) => op.oid)).toEqual(['p1:1', 'p2:1', 'p1:3', 'p2:4', 'p3:2']);

    // Missing peers count as 0, so their whole log is still owed.
    expect(opsSince(log, { p1: 1, p2: 2 }).map((op) => op.oid)).toEqual(['p1:3', 'p2:4', 'p3:2']);

    expect(opsSince(log, { p1: 3, p2: 4, p3: 2 })).toEqual([]);
  });

  it('records rejected stale operations so they are not requested again', () => {
    const state = emptyState();
    const stale: Op = {
      oid: 'stale',
      k: 'ann.put',
      s: { t: 3, p: 'p9' },
      image: IMG_A,
      ann: ann('x', 1),
    };
    const newerDel: Op = { oid: 'del', k: 'ann.del', s: { t: 5, p: 'p8' }, image: IMG_A, id: 'x' };
    applyOp(state, newerDel);
    expect(applyOp(state, stale)).toBe(false);
    expect(versionVector(state)).toEqual({ p8: 5, p9: 3 });
  });
});
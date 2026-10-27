# Team collaboration without a server

OpenLabel keeps the promise that images never leave the device that imported
them, and still lets several people work on one dataset. This document describes
how that works, what it deliberately does not do, and how to verify the
guarantees.

## Goal and constraint

A team of five wants to annotate 5 000 images. Uploading the dataset to a hosted
service is not acceptable; neither is a permanent server component that someone
has to operate.

The design that follows gives every annotator a full local copy of the project
and replicas that converge whenever they can reach each other. Connectivity is a
transport detail; correctness does not depend on any single device staying
online.

## Content addressing

Images are identified by the SHA-256 of their original bytes (`ImageMeta.hash`,
computed at import). That hash is the image key for every replicated fact:

- annotations are grouped by image hash, not by local database id;
- claims and review state are keyed by image hash;
- two people who imported the same photo from a shared folder or a USB stick
  line up automatically, even though their local rows have different ids.

Classes have the same problem: local class ids are generated per browser. The
replicated class identity is the normalized class name (`classKey`), and remote
annotations are mapped back to a local class id (created on demand) when they
arrive. Renaming a class therefore starts a new class identity — the UI treats
renames as explicit project operations, not as silent merges.

Images themselves are never transferred. If a peer does not have the bytes, it
sees the annotation metadata and the assignment board but cannot render the
photo. Distribute the pixels out of band (shared drive, USB, existing sync tool);
OpenLabel only replicates the work.

## Replicated state

Each project has one operation log and one state machine. An operation is one of:

| Operation | Meaning |
| --- | --- |
| `ann.put` | create or update an annotation |
| `ann.del` | delete an annotation (tombstone) |
| `img.meta` | image identity: name, size, dimensions, MIME, creation time |
| `img.claim` | assignment (or release, with `owner: null`) |
| `img.done` | review state |
| `class.put` | class definition |
| `proj.put` | project-level metadata |

Every operation carries a Lamport **stamp** `{t, p}`. Stamps are totally ordered
by counter, then peer id, so last-writer-wins resolves to the same winner on
every replica. `applyOp` is idempotent (`oid` membership) and order-independent,
which is what lets replicas exchange logs in any order:

- replaying the same operations twice changes nothing;
- an older stamp never overwrites a newer one;
- a delete is a tombstone, and only a strictly newer `ann.put` resurrects the
  annotation;
- the version vector records the highest counter seen per peer, including for
  operations that lost, so anti-entropy never re-sends a rejected write.

The operational log is persisted in its own IndexedDB database
(`openlabel-collab`) so that project-data migrations never touch it. On load the
log is replayed into memory; a 5 000-image project with ten annotations per image
is roughly 55 000 operations, which replays in well under a second and costs a
few megabytes.

## Transports

Two transports implement the same frame format `{v, from, ops, vv}`:

1. **Same browser profile.** A `BroadcastChannel` per project — tabs sync
   immediately, no pairing. Identity is per tab (`sessionStorage`), because two
   tabs share the database but are still two replicas.
2. **LAN pairing.** `RTCPeerConnection` with **no ICE servers**, so only host
   candidates are gathered and no third party learns anything. The offer and
   answer travel by copy/paste between the two people; there is no signaling
   server. Frames are capped at 1 MiB and backfill is chunked to 200 operations
   per frame.

Both are attached through a fan-out transport, so a session can serve tabs and
several paired devices at once.

Direct links only exchange what their two endpoints know, so every replica
announces its version vector every two seconds. Any peer that has seen an
operation relays it to a peer that is still missing it. Five annotators
therefore do not need a full mesh: pairing every device with one hub is enough,
and the hub forwards claims and annotations without any of them being uploaded
anywhere. The announcement is a handful of bytes; a reply only happens when
something is actually missing.

### What pairing exposes

An invite code contains the SDP of the connection, which includes the local IP
addresses of the device that created it. Share codes only with the people you
would tell those addresses to. No STUN/TURN traffic exists, so nothing is sent to
Google, Cloudflare, or any other infrastructure. Turning the tab off ends the
session; there is no presence beacon and no background service.

## Conflict behaviour

| Situation | Result |
| --- | --- |
| Two people label different images | Both sets merge; nothing is lost |
| Two people edit the same annotation | Later stamp wins; the earlier edit is replaced |
| One deletes, one edits the same annotation | Newer stamp wins; a delete after an edit stays deleted |
| Two people claim the same image | Later claim owns it; the other sees the owner and can pick another |
| Someone renames a class | Treated as a new class identity; old annotations keep their class |

The assignment board makes the common case cheap: claim a batch, work through it,
the board shows per-person counts on every replica.

## Limits

- No image transfer, by design.
- No merge UI for conflicting edits: the newer edit wins. (A per-annotation
  history view is a roadmap item.)
- Pairing is one-to-one per code. For five people, pair each device with the
  person who holds the dataset (a star); relaying through that peer is automatic.
- Image bits are not relayed: only metadata, annotations, claims, and review
  state are.
- Deletions are tombstones and are never garbage-collected, so the log only
  grows. At the current operation size this is a few kilobytes per thousand
  operations.

## Verification

- `tests/unit/collab-state.test.ts` — convergence under shuffled application
  order, idempotency, stamp ordering, tombstones, version vectors.
- `tests/unit/collab-sync.test.ts` — two replicas over a real `BroadcastChannel`,
  including a late joiner backfilling from the log.
- `tests/unit/collab-transport.test.ts` — invite-code codec and frame validation.
- `tests/e2e/team.spec.ts` — two real tabs pair, split the work, converge on
  review state, and pass an axe scan.
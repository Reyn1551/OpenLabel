# Architecture

OpenLabel is a static single-page application. There is no application server.
The browser owns storage, image decoding, training, inference, rendering, and
export. This document describes the module boundaries, data flows, storage
schema, worker protocol, performance budgets, and accessibility architecture.

---

## Runtime topology

```text
┌──────────────────────────────────────────────────────────────┐
│ Browser tab (one origin)                                     │
│                                                              │
│  React UI / canvas  ──────────────►  IndexedDB (`openlabel`)│
│        │                                  ▲                  │
│        │ postMessage                      │ model, versions  │
│        ▼                                  │                  │
│  auto-label Web Worker  ──────────────────┘                  │
│  (decode, descriptors, softmax, NMS, masks)                  │
│                                                              │
│  Exporters (main thread) ──► ZIP bytes ──► browser download  │
└──────────────────────────────────────────────────────────────┘
             ▲
             │ static assets, service worker cache
      Static host / PWA
```

There is no application API, authentication boundary, or server-side
validation. The only optional outbound request is a user-initiated image import
from a URL; the browser fetches that URL directly and the bytes are treated as
untrusted input. Any security property that depends on a trusted backend does
not apply. See [SECURITY.md](../SECURITY.md).

The application shell is precached by the service worker so the UI and the
few-shot engine remain available offline after the first successful load.

---

## Module map

### `src/core`: domain and persistence

| Module | Responsibility |
| --- | --- |
| `types.ts` | The domain model: projects, classes, geometries, annotations, image metadata, batches, dataset versions, auto-label settings, model bundles, predictions, shortcuts. All geometry is in source image pixel space. |
| `db.ts` | IndexedDB schema and connection management using `idb`. Defines the object stores, indexes, database name, and version. |
| `repo.ts` | Repository functions for projects, images, blobs, annotations, splits, dataset versions, models, metadata, and storage estimates. This is the only layer that should issue IndexedDB transactions for these entities. |
| `store.ts` | Studio state and orchestration: current project/image, tools, selection, history, undo/redo, import, training jobs, and prediction acceptance. |
| `geometry.ts` | Geometry helpers: bounding boxes, polygon simplification, point-in-shape tests, transforms, and geometry normalization. |
| `image.ts` | Browser image decoding, canvas drawing, thumbnail generation, 64-bit perceptual hash, 74-dimensional global descriptor, cosine similarity, and byte formatting. |
| `import.ts` | File, folder, and ZIP ingestion plus optional user-initiated URL import, per-file validation, content hashes, and progress. |
| `augment.ts` | Preprocess layout (none/stretch/fit), source-to-frame geometry transforms, augmented variant rendering, grayscale, and deterministic photometric augmentation. |
| `segment.ts` | Magic-wand flood fill and downscaling helpers for interactive polygon selection. |
| `health.ts` | Duplicate groups, similar-image search, class counts, tiny-object and split warnings, and the serializable dataset-health report. |
| `samples.ts` | Deterministic generated demo scenes for onboarding and tests. |
| `settings.ts` | Theme, locale, density, motion preference, and the synchronous settings mirror used before first paint. |
| `exporters.ts` | Dataset export pipeline: `buildExport` format switch, label/manifest serializers, optional preprocessed/augmented PNG rendering, warnings, and deterministic `zipExport`. |

### `src/autolabel`: pure few-shot engine

| Module | Responsibility |
| --- | --- |
| `features.ts` | RGBA image type, 4 px cell grid with 12 feature planes, summed-area tables, 194-dimensional window descriptors, IoU, deterministic PRNG. |
| `anchors.ts` | Deterministic k-means over log box sizes, anchor scale multipliers, proposal generation. |
| `model.ts` | Linear softmax with a background row, Adam training, scoring, template centroids, per-class NMS, F1 threshold selection. |
| `mask.ts` | GrabCut-lite box-to-polygon refinement: color models, largest component, hole filling, contour tracing, simplification. |
| `pipeline.ts` | End-to-end training, cross-validation, model bundle creation, detection/classification inference, keypoint prior placement. |
| `protocol.ts` | Worker request and response discriminated unions. |
| `client.ts` | Main-thread worker client: job ids, progress callbacks, result promises, and cancellation. |

The engine has no React, DOM, IndexedDB, or network dependency. It is
deterministic for a given dataset and seed, which is what makes tests and metric
comparisons meaningful.

### `src/workers`: execution boundary

`autolabel.worker.ts` is the only worker in the current architecture. It:

- decodes incoming blobs with `createImageBitmap` and `OffscreenCanvas`;
- scales images to a working long side of 768 px;
- calls `trainAutoLabel` or `predictImage`;
- posts progress, results, errors, and cancellation messages;
- checks cancellation between images.

The worker is a responsiveness and memory boundary, not a security sandbox.

### UI layers

- `src/features/`: feature screens and orchestration: project setup, image
  import, annotation, auto-label, review, dataset versions, export.
- `src/ui/`: reusable presentational primitives (buttons, dialogs, menus,
  fields) built on Radix UI primitives and Tailwind CSS v4.
- `src/lib/`: small browser, formatting, and download helpers.
- `src/locales/`: user-facing strings.
- `src/styles/`: Tailwind entry point and design tokens.

Dependencies flow inward: `features` and `ui` may depend on `core`,
`autolabel`, and `lib`; `core` and `autolabel` must not depend on React or UI
modules. Components do not open IndexedDB directly; they call repository
functions or feature-level state orchestration.

---

## Data model

All geometry coordinates are stored in source image pixels with the origin at
the top-left. The canvas can zoom, pan, or fit without changing stored values.

| Entity | Key fields | Notes |
| --- | --- | --- |
| `Project` | `id`, `name`, `type`, `classes`, `split`, `autoLabel` | `type` is `object-detection`, `instance-segmentation`, `keypoint`, or `classification`. Split percentages default to 70/20/10. |
| `ClassDef` | `id`, `name`, `color`, `keypoints?` | `keypoints` is the ordered skeleton for keypoint projects. |
| `ImageMeta` | `id`, `projectId`, dimensions, MIME, bytes, `hash`, `pHash`, `descriptor`, batch, split, `annotationCount` | The blob and thumbnail live in a separate store. `hash` is a SHA-256 content hash; `pHash` is perceptual. `split` is a per-image override; otherwise the split is derived. |
| `ImageBlob` | `id`, `blob`, `thumb` | Original bytes and a WebP thumbnail. |
| `Annotation` | `id`, `projectId`, `imageId`, `classId`, `geometry`, `source`, `confidence?` | Source is `human`, `auto`, or `import`. Accepted auto-labels retain their score. |
| `Batch` | `id`, `projectId`, `name`, `imageIds` | Groups an import session. |
| `DatasetVersion` | `id`, `projectId`, `number`, frozen `imageIds`, counts, `preprocess`, `augment` | Membership is frozen; later dataset edits do not mutate the version. |
| `ModelBundle` | weights, bias, anchors, templates, keypoint priors, image centroids, threshold, metrics, `formatVersion` | Serializable model; inference reconstructs typed arrays and maps. |

`Geometry` is a discriminated union: `bbox`, `polygon`, `keypoints`, and
`polyline`. Detection projects use `bbox`; segmentation projects use
`polygon`; keypoint projects use `keypoints`; classification stores a
full-image `bbox` placeholder with one class per image.

---

## IndexedDB schema

Database: `openlabel`, version `1`.

| Store | Key | Indexes | Contents |
| --- | --- | --- | --- |
| `projects` | `id` | `by-updated` | Project documents. |
| `images` | `id` | `by-project`, `by-batch` | Image metadata, dimensions, hashes, descriptors, split, counts. |
| `blobs` | `id` | none | Original image blob and thumbnail blob. |
| `annotations` | `id` | `by-image`, `by-project` | Human, auto, and imported annotations. |
| `versions` | `id` | `by-project` | Frozen dataset versions. |
| `models` | `id` | `by-project` | Serialized model bundles and metrics. |
| `meta` | key | none | Small application metadata. |

Rules:

- Every write that changes annotation membership updates the affected image's
  `annotationCount` in the same transaction where practical.
- Deleting a project cascades through images, blobs, annotations, versions, and
  models in one read-write transaction.
- Schema changes require a new `DB_VERSION` and an upgrade path. Never drop a
  store without a migration or an explicit, user-visible reset.
- Large binaries go in `blobs`, not in `images`; metadata lists must remain
  cheap to read.
- The database is origin-scoped. Changing host, port, or scheme creates a new
  database; the old data is not accessible from the new origin.

---

## Data flows

### 1. Image import

```text
File
  → SHA-256 content hash (exact duplicate rejection)
  → decodeImage (createImageBitmap, EXIF orientation)
  → makeThumbnail (384 px long side, WebP, quality 0.8)
  → computePHash (DCT-based 64-bit perceptual hash)
  → computeDescriptor (74-dimensional global descriptor)
  → ImageMeta + ImageBlob
  → one IndexedDB transaction over `images` and `blobs`

File names are checked against a 40 MB per-file limit and a supported
image-extension/MIME list. Errors are collected per file; one bad file does not
abort the batch. ZIP imports are expanded in memory, and URL imports use a
browser `fetch` initiated by the user.
```

The perceptual hash supports duplicate detection by Hamming distance. The global
descriptor feeds classification training and image-level similarity features.
Import does not upload anything.

### 2. Annotation editing

```text
pointer / keyboard
  → geometry in source pixel space
  → Annotation { source: 'human' }
  → repository transaction
  → `annotations` store + image `annotationCount`
  → canvas redraw
```

Undo and redo operate on annotation sets for an image. A replace operation
deletes existing annotations for that image and writes the new set in one
transaction, keeping the count consistent.

### 3. Split and dataset version

Splits are derived deterministically from the image index and the project's
percentage split, unless an image has a manual `split` override. The assignment
function interleaves images so small datasets do not get a degenerate split.

Creating a dataset version freezes:

- the image membership (`imageIds`);
- annotation and class counts;
- split counts;
- preprocessing settings (resize mode, dimensions, grayscale, auto-orient);
- augmentation settings (flips, rotation, brightness, contrast, saturation,
  noise, blur, copies).

Exports and audits target a version, not a moving project.

### 4. Training

```text
UI gathers project, classes, annotations, settings, and image blobs
  → postMessage({ type: 'train', jobId, ... })
  → worker decodes each image to ≤768 px long side
  → pipeline:
       features    build grids at 1.0 and 0.6 scale
       training    positives, jitters, negatives, anchors, linear softmax
       validating  image-level folds, F1 threshold sweep, metrics
       finalizing  refit on all samples, build bundle
  → postMessage({ type: 'trained', model, elapsedMs })
  → repository saves ModelBundle in `models`
```

Progress is reported with a stage, a 0–1 value, and a human-readable message.
The worker maps image decoding to 0–0.15 and pipeline progress to 0.15–1.0.

For classification projects, the pipeline uses one label per image derived from
the majority class of its annotations, a 74-dimensional global descriptor, and
leave-one-out validation.

### 5. Prediction and review

```text
UI sends model + image blobs
  → worker decodes at ≤768 px
  → predictImage:
       detection: proposals → softmax → template blend → NMS
       segmentation: detection box → refineBoxToPolygon
       keypoint: detection box → class layout prior
       classification: global descriptor → softmax
  → map working coordinates back to source pixels
  → postMessage({ type: 'predicted', results })
  → UI presents predictions for accept / edit / reject
```

Accepted predictions are stored as annotations with `source: 'auto'` and their
confidence. Corrections become human annotations and are eligible for the next
training run.

### 6. Export

```text
Project + dataset version/variants + ImageMeta[] + Annotation[]
  → buildExport(input, format) using the split resolver and augment settings
  → files in memory (text and binary), plus warnings
  → zipExport (fflate, fixed timestamp)
  → Blob URL + browser download
```

Serialization must be deterministic and must not read IndexedDB directly; all
input arrives through `ExportInput`, including image blobs via the `loadBlob`
callback. Formats that cannot represent a geometry must warn or fail rather
than silently drop labels. See
[CONTRIBUTING.md](../CONTRIBUTING.md#how-to-add-an-exporter).

---

## Collaboration

Team work is replicated, not hosted. Each project has an operation log in its
own IndexedDB database (`openlabel-collab`), and every replicated fact is keyed
by content: images by the SHA-256 of their bytes, classes by normalized name.
Operations carry Lamport stamps and merge by last-writer-wins, so replicas
converge regardless of the order they receive updates in.

Two transports share one frame format: a per-project `BroadcastChannel` for tabs
in the same browser profile, and a manual-signaling `RTCPeerConnection` with no
ICE servers for a device on the local network. Every connected replica
announces its version vector every two seconds, which lets any peer relay what
it has to a peer that is missing it. A star around the dataset owner is enough
for a five-person team. No image bytes are transferred and nothing is uploaded.

The studio bridge mirrors local edits into the log and writes merged remote state
back to IndexedDB and the live Zustand store; the Team page renders pairing,
presence, and the claim board from the same materialized state. See
[docs/COLLABORATION.md](COLLABORATION.md) for the algorithm, conflict table, and
limits.

---

## Worker protocol

Requests and responses are discriminated unions in
`src/autolabel/protocol.ts`.

| Direction | Message | Payload |
| --- | --- | --- |
| Main → worker | `train` | `jobId`, project id/type, classes, annotations, settings, image descriptors (`id`, `name`, `width`, `height`, `blob`). |
| Main → worker | `predict` | `jobId`, model bundle, settings, image descriptors. |
| Main → worker | `cancel` | `jobId`. |
| Worker → main | `progress` | `jobId`, stage (`features`, `training`, `validating`, `finalizing`, `predicting`), 0–1 progress, message. |
| Worker → main | `trained` | `jobId`, model bundle, elapsed milliseconds. |
| Worker → main | `predicted` | `jobId`, per-image predictions, elapsed milliseconds. |
| Worker → main | `error` | `jobId`, message. |
| Worker → main | `cancelled` | `jobId`. |

Protocol rules:

- Every request carries a `jobId`; responses must echo it so stale results can
  be ignored.
- Cancellation is cooperative. The worker checks between image decodes; a
  training pass that has already begun may run to completion before the
  cancellation is observed.
- Errors are converted to `{ type: 'error' }` messages; the worker must not
  leave a job without a terminal response.
- Worker input images include the original dimensions so predictions can be
  scaled from working resolution back to source pixels.
- The worker starts cold. Model runtime state is rebuilt from the serialized
  bundle on each job; no in-memory training state is assumed between jobs.

---

## Auto-label pipeline stages

Detailed constants and metric definitions are in
[AUTOLABEL.md](AUTOLABEL.md).

| Stage | Work | Main data structures |
| --- | --- | --- |
| Feature extraction | Decode, resize, build 4 px cell grids at two scales, summed-area tables. | `CellGrid`, integral planes |
| Sample generation | Positive boxes plus four jitters, random negatives, 194-d descriptors, anchor k-means. | `SampleRecord`, `Rect`, anchors |
| Training | Full-batch Adam on a linear softmax with a background row and inverse-frequency class weights. | `TrainedLinear` |
| Validation | Image-level folds, per-fold training, proposal generation, NMS, F1 threshold sweep. | `evaluateDetections` metrics |
| Finalization | Refit on all samples, build class templates, keypoint priors, image centroids, bundle. | `ModelBundle` |
| Prediction | Proposals, descriptor scoring, template blend, NMS, geometry conversion. | `Prediction[]` |

Segmentation refinement and keypoint prior placement happen after detection,
during prediction, so the detector remains shared across project types.

---

## Performance budgets

These are engineering budgets, not benchmark guarantees. They exist to catch
regressions; actual times depend on image content, dataset size, and hardware.

| Area | Budget | Mechanism |
| --- | --- | --- |
| Initial route JavaScript | ≤ 350 KB gzip (target) | Route-level code splitting, PWA precache; Vite warns at 900 KB per chunk. |
| Annotation frame | ≤ 16.7 ms typical | Canvas overlays, no per-frame React tree rebuilds, avoid copying pixel buffers. |
| Thumbnail | 384 px long side, WebP q0.8 | Import path calls `makeThumbnail` with 384; keep import batches bounded. |
| Working image | 768 px long side | Worker decode plus 768 px cap; source scale retained for inverse mapping. |
| Descriptor | O(1) per proposal after grid build | Summed-area tables; 16 sub-cells × 12 values + 2 shape values. |
| Proposal cap | 40,000 per image level | `generateProposals` limit across anchors and scales; per-class NMS afterwards. |
| Training (50 images) | ≤ 10 s target in the worker | One feature pass per image, linear model, 140–180 full-batch epochs. |
| Prediction | ≤ 1.5 s per image target | Two working scales, capped proposals, per-class NMS. |
| Main-thread work | No pixel loops over full images | Decode, descriptor extraction, training, and inference in the worker. |
| Storage writes | Batched transactions | Repository transactions for import, annotation replacement, and project deletion. |
| PWA precache | 6 MB per file ceiling | `maximumFileSizeToCacheInBytes` in Vite PWA config. |

Performance changes should state the dataset, hardware, browser, and measured
before/after numbers. Do not trade correctness or validation honesty for a
smaller metric.

---

## Accessibility architecture

The target is WCAG 2.2 Level AA. Accessibility is designed into the component
layer and verified in end-to-end tests.

- **Semantic foundation.** Native elements are preferred. Dialogs, menus,
  popovers, tabs, switches, sliders, and tooltips use Radix UI primitives for
  focus management, Escape handling, roving focus, and portal behavior.
- **Keyboard path.** Canvas editing supports keyboard placement, nudging,
  completion, cancellation, and deletion. Tool and class controls are reachable
  in the normal focus order. Full keyboard coverage of every workspace action is
  a review requirement, and global shortcuts are disabled while focus is in an
  editable field.
- **Canvas alternative.** The canvas is not the only representation of the
  dataset. The annotation list must expose each annotation's class and geometry
  as text, support selection and deletion, and keep focus order predictable.
  Canvas-only affordances must have an accessible counterpart.
- **Status announcements.** Training progress, prediction results, export
  completion, and errors are announced through polite or assertive live regions
  as appropriate. Progress bars carry an accessible name and numeric value.
- **Visual design.** Class identity is paired with text, not color alone.
  Contrast targets are 4.5:1 for normal text and 3:1 for large text and UI
  boundaries. Focus rings remain visible against canvas and panel backgrounds.
  Target sizes aim for 24×24 CSS px. Layout must reflow at 320 px and 200% zoom.
- **Motion.** Non-essential animation respects `prefers-reduced-motion`;
  progress must remain understandable without animation.
- **Automated and manual checks.** The Playwright stack includes axe-core, and
  UI changes are expected to add checks for new screens. Automated checks are a
  floor, not a certification. Annotation and dialog changes should also be
  exercised with a keyboard and a screen reader.

---

## Failure modes

| Condition | Expected behavior |
| --- | --- |
| `OffscreenCanvas` or `createImageBitmap` unavailable | Surface an explicit unsupported-browser error; do not silently skip images. |
| Storage quota exceeded | Report the failed write, keep the existing project intact, and suggest exporting and removing unused images. |
| Corrupt or unsupported image | Skip the file with a per-file error; do not abort the entire batch. |
| Incompatible model `formatVersion` | Refuse inference and ask the user to retrain. |
| Worker exception | Post an error for the job id; UI returns to an actionable state. |
| Cancellation during training | Acknowledge between images; a started training pass may finish before cancellation takes effect. |
| Missing annotations for training | Reject with a clear message; do not produce a degenerate model. |

---

## Related documents

- [Auto-label algorithm](AUTOLABEL.md)
- [Roadmap](ROADMAP.md)
- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
## Platform boundary: browser, PWA, and optional desktop shell

The renderer is plain TypeScript plus DOM APIs; nothing imports Node built-ins.
That keeps three deployment shapes possible without duplicating logic:

1. **Static site / PWA** (shipped): `vite build`, service worker precache, IndexedDB.
2. **Folder mode** (progressive enhancement): `src/core/fs-access.ts` reads a
   directory the user picks and writes exports back with the File System Access
   API. It returns `supported: false` instead of throwing elsewhere, so Firefox
   and Safari keep the upload/download flow.
3. **Desktop shell** (roadmap): a Tauri wrapper can call the same modules; the
   canvas, workers, and exporters have no framework coupling beyond React.

Native-only capabilities are always optional: no feature requires filesystem
access, a server, or a GPU.

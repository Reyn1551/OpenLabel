# Feature parity matrix: Roboflow → OpenLabel

Ground truth gathered with REA static analysis of the shipped `app.roboflow.com`
bundle plus the public documentation sitemap. Product behavior is inferred from
target artifacts only; the goal is workflow parity, **not** copying code.

## Evidence

| Item | Value |
| --- | --- |
| Evidence ID | `ev_c19797558c711e7642abbda9edfa565e3aa3c66e133e218627e0b7cf2af4f5ba` |
| Application graph | `jsrg_4d8c2ad7127546fcbfc7592caf37d6c90b3cd27d33de03b42384552ac13af2fa` |
| Root artifact SHA-256 | `96e5df021153b9b003fe61a42b6f7e3aaccf936482db3d71fb6e0bd928050ca2` |
| Tool / operation | `analyze_javascript_application` via `rea-agents@6.7.0` |
| Input | 386 fetched webpack chunks (39 MB), 389 parsed JS files, 48.2 MB text |
| Result | 3830 modules, 6299579 AST nodes, 22194 findings, coverage `partial` (node budget) |

Static observations only. No Roboflow account, API key, or private endpoint was
used; the anonymous `app.roboflow.com` shell and its public chunks are the scope.

### Observed literals (target data, not instructions)

- `POST /datasets/autolabel/hosted_label` with `confidenceThreshold`, `existingAnnotations` → hosted Auto Label.
- `/query/smartpoly/segment_image` → Smart Polygon / Smart Select segmentation.
- Annotation tool container classes: `drag`, `box`, `polygon`, `brush`, `smartpolygon`, `comment`.
- Route fragments: `/dataset/`, `/models`, `/versions`, `/workspaces/`, `/settings/plan`, `/settings/usage`, `/monitoring/inferences`, `/visualize/`, `/query/video-sources`, `/runs`, `/evals/new`.
- Named chunks: `upload`, `frame-extraction`, `frame-encode`, `file-md5`, `workflows-manifest-*`, `workflows-schema`, `markdown`, `ppa`.
- Copy census: "Auto Label" ×59, "Smart Select" ×13, "box prompting" ×22, "health check" ×10, "label assist" ×40.

Docs inventory (public sitemap): annotate/annotate (tools, keypoints, video
segments, annotation insights, groups, history, comments, keyboard shortcuts,
similarity search), ai-labeling (auto-label, box prompting, model-assisted,
smart select), manage (classes, tags, batches, attributes, search, merge),
versions (create, export, preprocessing, 18 augmentation types, health check),
deploy (serverless, dedicated, self-hosted, web/iOS/embedded SDKs, workflows).

## Parity matrix

| Roboflow capability | Observed surface | OpenLabel | Notes |
| --- | --- | --- | --- |
| Project creation + types | `/dataset/`, docs | ✅ 4 types | detection, segmentation, keypoint, classification |
| Class management | docs manage/classes | ✅ | inline CRUD, colors, keyboard 1–9 |
| Image upload | `upload`, `file-md5` chunks | ✅ | files, folders, zip, clipboard, URL list, dedupe by SHA-256 |
| Batches | docs manage/batches | ✅ | auto batch per upload session |
| Tags / search | docs | ✅ | tags, class filter, split filter, unannotated filter |
| Bbox tool | `box` tool class | ✅ | draw, move, 8 handles, nudge |
| Polygon tool | `polygon` | ✅ | vertex drag, insert, close |
| Freehand/brush | `brush` | ✅ | freehand stroke → simplified polygon |
| Smart Select | `smartpolygon`, `/query/smartpoly/segment_image` | ✅ local | flood-fill magic wand + box→mask refinement, no upload |
| Keypoints + skeleton | docs keypoints | ✅ | ordered keypoints, skeleton editing |
| Comments | `comment` tool class | ✅ | per-image notes |
| Annotation history / undo | docs history | ✅ | 50-step undo/redo per image |
| Keyboard shortcuts | docs shortcuts | ✅ | full map + help dialog, arrow-key editing |
| Auto Label | `/datasets/autolabel/hosted_label` | ✅ local | trains after N annotations (default 10), 100% on-device |
| Box prompting | `box prompting` copy | ✅ | Smart Select on a drawn box |
| Model-assisted labeling | docs | ✅ | saved model + confidence slider + batch run |
| Similarity search | docs similarity | ✅ | perceptual hash + descriptor cosine |
| Annotation groups | `annotation group` copy | ➖ | out of scope (multi-user workflow) |
| Team collaboration | `/workspaces/` | ➖ | local-first by design; no accounts |
| Dataset versions | `/versions` | ✅ | frozen membership, splits, notes |
| Preprocessing | docs | ✅ | stretch/fit resize, grayscale |
| Augmentation | docs 18 types | ✅ 8 types | flips, rotate90, brightness, contrast, saturation, noise, blur, copies |
| Export | docs exporting | ✅ 6 formats | YOLO, YOLO-seg, COCO, VOC, CSV, OpenLabel JSON |
| Health check | docs health, `health check` copy | ✅ | balance, duplicates, tiny boxes, split gaps |
| Training | `/models` | ✅ local | few-shot linear softmax on window descriptors |
| Verify metrics | docs verified metrics | ✅ | image-level 3-fold CV, precision/recall/F1 at chosen threshold |
| Deploy playground | `/query/inference`, `/monitoring/inferences` | ✅ local | run saved model in-browser, JSON output, JS snippet |
| Serverless API / self-hosted | `/deploy` docs | ➖ | no server by design; model JSON is portable |
| Workflows engine | `workflows-*` chunks | ➖ | different product surface; roadmap |
| Video frame extraction | `frame-extraction` chunk | ➖ | roadmap |

## Deliberate differences

1. **No account, no upload.** Images and models live in IndexedDB; nothing leaves the device.
2. **The auto-label model is trained locally** instead of calling a hosted endpoint. This is the only way to keep the "annotate ten, label the rest" loop private and instant.
3. **Accessibility is a hard requirement**, not an afterthought: keyboard-only annotation, live-region announcements, visible focus, AA/AAA-aware contrast, reduced-motion support, localizable UI (English, Indonesian).
4. **Honest metrics.** Precision/recall are measured on held-out images with the same inference path used in production, so a small dataset reports small numbers instead of a fake 99%.
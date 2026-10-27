# OpenLabel auto-label algorithm

This document specifies OpenLabel's few-shot engine implemented in `src/autolabel/` and
`src/workers/autolabel.worker.ts`. It is intentionally precise: the engine is a
small, deterministic classical-vision pipeline, not a neural network. Knowing
the constants is the fastest way to predict when it will work and when it will
not.

The model format version is **1**. Weights are stored as flat number arrays;
inference reconstructs typed arrays and maps from the bundle.

---

## 1. Scope and design constraints

- **CPU only.** No GPU, WebGPU, ONNX runtime, downloaded weights, or external
  inference service.
- **Two implementations, one behaviour.** The pixel-bound stage exists as a
  TypeScript reference and as a Rust/WebAssembly module (see
  [ENGINE.md](ENGINE.md)); the parity suite fails if they disagree.
- **Deterministic.** Given the same images, annotations, settings, and code
  version, training is reproducible. The PRNG is `mulberry32`; seeds are fixed
  per stage.
- **Few-shot.** The default gate is 10 human annotations. The classifier is
  linear over hand-designed descriptors so it can converge in seconds.
- **One detector for three project types.** Detection, segmentation, and
  keypoint projects share the same proposal and classification stage. Geometry
  conversion happens afterwards.
- **Image-level validation.** Folds split whole images, never individual boxes,
  so near-duplicate descriptors from the same photo cannot inflate metrics.

---

## 2. Working resolution and preprocessing

Images are decoded in the worker with `createImageBitmap` and drawn to an
`OffscreenCanvas`. The working image is scaled so its **long side is at most
768 px**:

```text
scale = min(1, 768 / max(sourceWidth, sourceHeight))
workingWidth  = max(1, round(sourceWidth  * scale))
workingHeight = max(1, round(sourceHeight * scale))
```

No letterboxing, padding, or aspect-ratio change is applied. The scale is kept
so predictions can be mapped back to source pixels.

Two feature grids are built from the working image:

| Level | Scale | Construction |
| --- | --- | --- |
| Base | 1.0 | `buildCellGrid(working, 4)` |
| Half | 0.6 | Bilinear resize to `round(width * 0.6)` × `round(height * 0.6)`, then a 4 px grid |

The half level is a coarse scale for larger objects. It is used both for
positive samples and for inference. Random negatives are sampled only from the
base level.

Source annotations are in source pixel space. A box is mapped to a level by
multiplying by `image.scale * level.scale`.

---

## 3. Cell grid features

Each grid cell covers **4 × 4 pixels**. A grid has `ceil(width / 4)` ×
`ceil(height / 4)` cells. Edge cells average only the pixels that exist.

Every cell stores **12 values** (`CELL_PLANES = 3 + 8 + 1`):

| Plane | Value | Normalization at descriptor time |
| --- | --- | --- |
| L | Mean luminance `0.299R + 0.587G + 0.114B` | `value / 255 - 0.5` |
| A | Mean red–green proxy `R - G` | `value / 510` |
| B | Mean yellow–blue proxy `0.5(R + G) - B` | `value / 510` |
| Orientation 0–7 | Sum of gradient magnitude in 8 unsigned orientation bins | Per-subcell histogram normalized to sum 1 |
| Magnitude | Sum of gradient magnitude | `log1p(value / 255 * 8)` |

Gradients use central differences on luminance with edge clamping:

```text
gx = (L(x + 1, y) - L(x - 1, y)) * 0.5
gy = (L(x, y + 1) - L(x, y - 1)) * 0.5
```

The orientation is folded into `[0, π)` and quantized into 8 bins. Unsigned
orientation keeps descriptors stable under horizontal flips and 180° rotations.

The bin is chosen by comparing `gy / gx` against `tan(k·π/8)` rather than
computing `atan2`: the angle is only ever used to pick a bucket, and `atan2` has
no WebAssembly instruction, so it dominated the pixel pass. The two formulations
agree on every gradient; `tests/unit/engine-parity.test.ts` pins the bins and
descriptors between the TypeScript reference and the compiled engine.

For each plane, a summed-area table is built once. Any rectangular cell range
then costs four lookups, so descriptor extraction is O(1) per proposal
regardless of proposal size.

---

## 4. Window descriptor

A proposal rectangle is converted to a cell range:

```text
x0 = clamp(floor(rect.x / 4), 0, gw)
y0 = clamp(floor(rect.y / 4), 0, gh)
x1 = clamp(ceil((rect.x + rect.width) / 4), 0, gw)
y1 = clamp(ceil((rect.y + rect.height) / 4), 0, gh)
```

Proposals crossing the image border are scored on their visible portion.

The cell range is divided into a **4 × 4** grid of sub-cells. Each sub-cell
contributes its 12 averaged values. The final descriptor is:

```text
16 sub-cells × 12 values = 192
+ log(width / height) / 4        (shape)
+ log(area / imageArea) / 8      (relative size)
= 194 dimensions
```

Details:

- Sub-cell boundaries are computed in floating point and snapped to cell
  indices with at least one cell per sub-cell.
- Orientation histograms are normalized **per sub-cell** by their own sum; an
  empty histogram stays zero.
- The shape terms are clamped against division by zero before `log`.
- The complete 194-dimensional vector is L2-normalized. Cosine similarity and
  the linear classifier therefore operate on the unit sphere.

`DESCRIPTOR_DIM` is exported and used to validate the model's `dim` field.

---

## 5. Training samples

### Positives

For every usable annotation:

1. Compute its bounding box. Keypoint annotations with zero points are
   skipped. Boxes whose source width or height is under 8 px are skipped.
2. Choose a feature level:
   - keep levels where `min(boxSide) * level.scale` is between 12 and 512 px;
   - prefer the level whose scaled short side is closest to 64 px;
   - fall back to the base level if no level qualifies.
3. Scale the box into level coordinates. Skip it if its scaled short side is
   below 8 px.
4. Emit five positive descriptors: the exact box plus four jitters:

| Jitter | `dx` | `dy` | `scaleW` | `scaleH` |
| --- | --- | --- | --- | --- |
| exact | 0 | 0 | 1.00 | 1.00 |
| expand | +0.06 | +0.04 | 1.08 | 1.06 |
| shrink | −0.06 | −0.04 | 0.94 | 0.96 |
| shift A | +0.03 | −0.05 | 1.05 | 0.94 |
| shift B | −0.04 | +0.05 | 0.96 | 1.05 |

Jittered boxes are clamped to the level bounds. The label is the class index.
This gives the linear classifier a little translation and scale tolerance
without any pixel-level augmentation.

### Negatives

For each image, the generator emits `max(12, 3 × positiveBoxCount)` background
windows:

- pick an anchor uniformly from the learned anchors;
- pick a scale multiplier uniformly from `[0.7, 1.0, 1.4]`;
- skip sizes below 12 px;
- pick a random top-left position that fits the grid;
- reject the window if its IoU with any positive box is above 0.15;
- give up after `40 × requestedCount` attempts.

Negatives are always sampled from the base grid. They use the per-image
deterministic PRNG seed `7919 + imageIndex`.

Background is class row `C` (the last row), not a separate class id.

---

## 6. Anchors

Anchor sizes are learned from annotated boxes mapped to working resolution:

1. Keep boxes with width and height ≥ 8 px.
2. Convert each to `(log(width), log(height))`.
3. Choose `k = min(3, boxCount)` clusters.
4. Initialize centers at evenly spaced quantiles of the boxes sorted by
   `log(width) + log(height)`.
5. Run 25 Lloyd iterations with squared Euclidean distance in log space.
6. Convert centers back with `exp`, clamping each side to at least 8 px.

If there are no valid boxes, the anchor set is a single 64 × 64 box.

The detector combines every anchor with scale multipliers `[0.7, 1.0, 1.4]`
during proposal generation. Anchors are stored in `ModelBundle.anchors` in
working-image pixels.

---

## 7. Linear softmax classifier

### Architecture

A single linear layer maps a 194-dimensional descriptor to `C + 1` logits:

```text
rows = number of classes + 1    (last row is background)
logits[r] = bias[r] + Σ_d weights[r, d] * x[d]
p = softmax(logits)
```

There is no hidden layer, activation, or nonlinearity.

### Optimization

- Full-batch **Adam** (β₁ = 0.9, β₂ = 0.999, ε = 1e-8).
- Default 140 epochs; cross-validation folds use 120; the final refit uses 180.
- Learning rate 0.05.
- L2 regularization 1e-3.
- Class weighting: each sample's loss is weighted by
  `1 / sqrt(count[label])`, where background counts toward its own row. This
  keeps the large negative pool from dominating.
- Weights initialize from a Gaussian with standard deviation `sqrt(2 / dim)`,
  generated deterministically with Box–Muller from `mulberry32`.
- Seeds: 1337 for generic training, `1000 + fold` for CV folds, 2024 for the
  final detection refit, 77 for the final classifier refit.

### Scoring

`scoreDescriptor` computes softmax probabilities and takes the highest
probability among non-background rows. It also returns the background
probability when one exists.

### Templates

For each class, `buildTemplates` computes the normalized centroid of all
positive descriptors of that class (including jittered copies). Inference can
blend cosine similarity to this template into the class score:

```text
finalScore = confidence * ((1 - templateWeight) + templateWeight * max(0, cos(x, template)))
```

`templateWeight` defaults to 0.35. Set it to 0 to disable blending.

---

## 8. Proposals and detection

At inference, for each level:

1. Scale the learned anchors by the level scale.
2. For each anchor and each multiplier in `[0.7, 1.0, 1.4]`:
   - width/height = `max(14, anchorSide * multiplier)`;
   - skip if the proposal exceeds 1.2 × the level dimension;
   - stride X = `max(8, round(width * 0.28))`;
   - stride Y = `max(8, round(height * 0.28))`;
   - slide while `x + 0.35 * width <= levelWidth` and
     `y + 0.35 * height <= levelHeight`.
3. Stop after **40,000 proposals per level** across all anchors and
   multipliers. The cap is a safety valve, not a quality target.

Each proposal is described and scored:

- reject early if class confidence is below `0.75 × threshold`;
- apply the optional template blend;
- reject if the final score is below the threshold.

### Weighted boxes fusion

Dense sliding windows produce many shifted copies of the same object. Raw
proposals are clustered per class by IoU with a fused box (threshold **0.1**);
each cluster is replaced by the score-weighted average of its member boxes and
the mean member score. Only then is non-maximum suppression applied:

```text
fused.x = sum(score_i * x_i) / sum(score_i)
fused.score = mean(score_i)
```

This turned eight-ish duplicate detections per object into one box on the
synthetic regression fixtures, and it is covered by the precision assertion in
`tests/unit/autolabel.test.ts`.

### Box-size calibration

The classifier slightly prefers tight windows that sit inside an object, so
predicted boxes are systematically smaller than ground truth. During
cross-validation, every ground-truth box is matched to its best prediction
(IoU >= 0.3) and the median ratio `gt.width / predicted.width` (same for
height) is stored in the bundle as `boxScale`, clamped to **0.6–2.0**. Inference
expands each fused box around its center before mapping back to source pixels.
Calibration is learned, not hardcoded.

### Non-maximum suppression

NMS is greedy and **per class**:

1. Sort candidates by descending score.
2. Keep a candidate if its IoU with every already-kept box of the same class is
   ≤ `nmsIou`.
3. Apply `maxPerImage` as a per-class limit, merge classes, sort globally, and
   keep the top `maxPerImage` overall.

Both feature levels run independently, then a final NMS pass merges their
predictions in working-image space. Boxes are divided by the level scale before
this merge.

### Runtime threshold

`AutoLabelSettings.confidence` is the threshold passed to inference. The
threshold selected during validation is stored in `ModelBundle.threshold` and
in `metrics.threshold`; it is **not** automatically substituted at prediction
time. Callers that want the validated operating point should pass it explicitly
or update the project's confidence setting.

---

## 9. Geometry conversion

### Object detection

The working-space box is scaled by:

```text
scaleX = sourceWidth / workingWidth
scaleY = sourceHeight / workingHeight
```

and stored as a `bbox` in source pixels. Predictions below the runtime
threshold are dropped.

### Instance segmentation

Polygons come from a GrabCut-lite pass (`src/autolabel/mask.ts`): the box is
downscaled to at most 192 px, foreground and border colour means seed a
two-class split, holes are filled, the largest 4-connected component is kept,
and its outline is traced with **marching squares** on a 1 px-padded mask. The
largest closed loop is simplified with Ramer–Douglas–Peucker. When foreground
and border colours are too close (distance < 24 in RGB), the box corners are
returned instead of a meaningless mask.


The detector still works on boxes. For each predicted box, `refineBoxToPolygon`
runs on the **working-resolution** RGBA image:

1. Crop around the box with padding `round(min(width, height) * 0.06) + 2`.
2. Downscale the crop so its long side is at most 192 px (nearest-neighbor
   sampling).
3. Estimate foreground color from the central 60% of the box.
4. Estimate background color from the outer 8% ring of the crop.
5. Inside the box, mark a pixel foreground when
   `1.05 * distanceToForeground² < distanceToBackground²`.
6. Fill holes, keep the largest 4-connected component.
7. If the component is under 12% of the box's inner area, fall back to the four
   box corners.
8. Trace the boundary with Moore-neighbor tracing, keep every other contour
   point, map back to working pixels, then simplify with tolerance
   `max(1.2, 0.004 * (boxWidth + boxHeight))`.
9. If fewer than 3 vertices remain, fall back to the box corners.
10. Scale the polygon to source pixels.

This is a color-separation heuristic, not a learned mask. It works best on
solid, reasonably contrasted objects and fails on camouflage, transparency, and
objects with colors similar to the background.

### Keypoints

The model stores `keypointPriors`: the mean normalized layout per class,
computed from annotated keypoint geometry. Each point is normalized inside its
annotation's bounding box, then averaged point-by-point across samples of the
same class. If samples have different point counts, only the common prefix is
used.

At prediction time, the class's prior is placed inside the predicted box:

```text
point = (box.x + priorX * box.width, box.y + priorY * box.height)
```

If a class has no prior, the prediction remains a box. Keypoints therefore
capture average pose, not per-instance articulation.

### Classification

Classification bypasses proposals, anchors, templates, NMS, and segmentation.
Each working image is summarized by a **74-dimensional global descriptor**:

| Block | Dimensions | Content |
| --- | --- | --- |
| Color layout | 48 | 4 × 4 grid of mean R, G, B values, normalized per block |
| Gradient orientation | 8 | Magnitude-weighted unsigned orientation histogram |
| Gradient energy | 16 | Magnitude sum over a 4 × 4 grid |
| Shape and brightness | 2 | Clamped aspect ratio / 2, mean luminance |

The color, orientation, and energy blocks are each L2-normalized before
concatenation. A linear softmax with `C` rows (no background row) predicts the
image's class. The top class and its confidence are returned. The bundle stores
a fixed threshold of 0.5, but `predictImage` does not drop classification
predictions by that threshold; callers decide how to review low-confidence
labels.

---

## 10. Validation and metrics

### Detection, segmentation, and keypoint projects

Validation uses **image-level k-fold cross-validation**:

- `k = min(3, number of unique images that produced samples)`.
- Folds are assigned by image index modulo `k`.
- For each fold, the classifier is trained on samples from the other images and
  evaluated on the held-out images.
- Every fold trains for 120 epochs with seed `1000 + fold`.
- Predictions use a permissive threshold of 0.2, the project's NMS IoU, and a
  cap of 20 per level.
- Ground truth is the set of annotated boxes in working-image coordinates.

A prediction is a true positive when:

- its class matches the ground-truth class;
- its IoU with that ground truth is **strictly greater than 0.5**;
- the ground-truth box has not already been matched.

For each candidate threshold in
`[0.2, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8]`:

```text
precision = TP / predictions_at_or_above_threshold
recall    = TP / ground_truth_count
F1        = 2 * precision * recall / (precision + recall)
```

If precision + recall is zero, F1 is zero. The threshold with the highest F1 is
selected. The bundle reports the precision, recall, and F1 of the best fold,
while `evaluated` is the total number of held-out ground-truth boxes across all
folds. It is not a pooled confusion matrix.

If only one image is available, no honest holdout exists. The engine trains on
all samples, evaluates in-sample on the base level, and records those metrics.
Treat such metrics as optimistic.

### Classification

Classification uses **leave-one-out** validation over labeled images:

- For each image, train a classifier on the other images and predict the held-out
  image's majority class.
- Accuracy is `correct / predicted`.
- The final model is refit on all labeled images with 220 epochs.

The bundle stores the leave-one-out accuracy in `precision`, `recall`, and
`f1`, with `evaluated` equal to the number of held-out predictions. It is
accuracy, not a detection metric.

### Model bundle

`ModelBundle` stores:

```text
id, projectId, createdAt, projectType
classes, trainedOn, dim
weights, bias                 row-major (C + 1) × dim for detection
anchors                       working-image pixels
templates                     per-class mean positive descriptor
keypointPriors                per-class normalized layouts
imageCentroids                per-class global descriptor means
threshold, metrics            validation operating point
config, formatVersion = 1
```

Classification bundles have empty anchors, templates, and keypoint priors, and
`dim = 74`.

---

## 11. Known limitations

- **Small objects.** The working long side is 768 px. Objects whose short side
  falls below roughly 12 px after scaling are filtered from training, and
  proposals are capped at a minimum size of 14 px. A 20 px object in a
  6000 px-wide photo will be nearly invisible to the model.
- **Extreme aspect ratios.** Very long, thin objects are poorly represented by
  square-ish sub-cells and anchor scales. The shape features help ranking, not
  localization.
- **Dense or overlapping instances.** NMS and the 25-per-image default can
  suppress legitimate overlapping objects of the same class.
- **Visually similar classes.** The descriptor uses color and unsigned gradient
  statistics. Classes distinguished by fine texture, text, or context will
  confuse it.
- **Background bias.** Proposals and negatives come from the same image
  content. A class that is defined by context rather than appearance will learn
  the context.
- **No explicit hard-negative mining.** The app's training path sends only
  annotated images. Unannotated project images do not act as hard negatives;
  background examples are sampled as random windows from the training images.
- **Class imbalance.** Inverse-square-root weighting mitigates but does not
  solve one-class dominance. Metrics on rare classes will be noisy.
- **Template overfitting.** A high `templateWeight` can favor a class with a
  tight visual mean. Set it to 0 when classes are visually diverse.
- **Validation with tiny datasets.** Three folds over ten images leaves few
  validation boxes per fold. The F1-optimal threshold can be unstable; repeat
  with more data before trusting small metric changes.
- **Segmentation quality.** The mask refinement is a classical color-model
  heuristic. It does not understand object boundaries and falls back to a box
  when the foreground cannot be separated.
- **Keypoint quality.** Predictions use an average layout. They do not model
  pose, occlusion, viewpoint, or per-instance variation.
- **Classification scope.** One class per image, full-frame descriptor, no
  multi-label and no object localization. Background and framing strongly
  affect predictions.
- **No GPU.** Everything is CPU-bound in one worker. Dataset size and image
  count scale the wall-clock time, not the model capacity.
- **Determinism has limits.** Results are stable for fixed inputs, code, and
  seeds, but not across code or format versions. Do not compare metrics across
  `formatVersion` changes without re-running both.
- **The validated threshold is informational.** Runtime inference uses
  `AutoLabelSettings.confidence`; the bundle does not override it.

---

## 12. Tuning guide

### Project settings

| Setting | Default | Effect |
| --- | --- | --- |
| `minAnnotations` | 10 | Training gate only. It does not change the optimizer. Raise it for heterogeneous classes; lower it only for experimentation. |
| `confidence` | 0.55 | Runtime score threshold. Raise for precision and a shorter review queue; lower for recall and more false positives. |
| `maxPerImage` | 25 | Hard cap after NMS. Raise for dense scenes, remembering review cost. |
| `nmsIou` | 0.45 | Lower suppresses more overlapping boxes; higher keeps more duplicates and legitimate overlaps. |
| `templateWeight` | 0.35 | Blend of class-mean cosine similarity. Lower or zero for visually diverse classes; slightly higher for tight, consistent appearances. |

### Improving accuracy

1. **Annotate the failures, not more easy examples.** Accept, correct, retrain.
   Corrections are the highest-value data.
2. **Keep boxes tight.** The descriptor is computed from the proposal rectangle;
   loose boxes include background.
3. **Cover appearance variation.** Different lighting, scale, viewpoint, and
   background per class. Four jitters cannot synthesize what is missing.
4. **Balance classes.** Add examples for rare classes; the loss weighting is a
   mitigation, not a substitute.
5. **Check object size.** If the short side is under ~20 px at 768 px working
   resolution, the model has little signal. Crop or upscale the source imagery.
6. **Separate visually distinct classes.** If two classes differ mainly by
   context, consider merging them or adding a project-specific attribute.
7. **Use the confusion between precision and recall deliberately.** For a
   review-first workflow, lower confidence and review more; for a high-trust
   batch, raise it.
8. **Do not tune on the reported number alone.** Small folds are noisy. Hold
   out a fresh batch of images for a final sanity check.
9. **Segmentation:** prefer solid objects with clear foreground/background
   contrast. If masks consistently fall back to boxes, the color model cannot
   separate the object.
10. **Keypoints:** annotate consistent skeletons and poses. A single mean layout
    cannot represent multiple canonical poses.
11. **Classification:** keep framing and background consistent within a class.
    If the class is really "object present somewhere in the frame", a global
    descriptor is the wrong tool.

### Reading the metrics

- High precision, low recall: the model is conservative. Lower `confidence`.
- Low precision, high recall: too many false positives. Raise `confidence` or
  tighten annotations.
- Both low: the descriptor or the data is insufficient. Add diverse examples;
  check object size.
- Good training metrics but poor review results: the validation split is too
  small or too similar to training. Add independent images.
- Classification precision/recall/F1 are the same accuracy number. Do not read
  them as detection metrics.

---

## 13. Reproducibility checklist

When reporting an auto-label result, include:

- project type and class count;
- number of images and annotations used for training;
- `minAnnotations`, `confidence`, `nmsIou`, `maxPerImage`, `templateWeight`;
- model `formatVersion`;
- precision, recall, F1, `evaluated`, and the selected threshold;
- browser and hardware;
- whether segmentation/keypoint post-processing was involved.

Without those, a metric is not comparable.
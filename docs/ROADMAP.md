# Roadmap

OpenLabel is pre-1.0. This roadmap describes direction, not commitments. Items
move when they are ready, when a maintainer can support them, and when they keep
the project local-first.

The guiding constraint is simple: **no server, no account, no telemetry, and no
upload path for user data.** Proposals that require a hosted backend are out of
scope for the core project.

---

## Near term (0.2–0.3)

### Annotation ergonomics

- Vertex and edge editing for polygons, with keyboard nudging.
- Better box resizing and snapping, including handles that remain usable at low
  zoom.
- Configurable class colors and clearer active-class state.
- Reliable focus return after tool changes, dialogs, and image navigation.
- Touch and pen input for the core drawing tools.

### Review throughput

- Review queue sorted by confidence, class, and annotation source.
- Batch accept/reject with an explicit undo path.
- Filters for auto-labeled annotations, low-confidence predictions, and images
  with no annotations.
- Keyboard-only review flow that does not require reaching for the pointer.

### Import robustness

- Per-file import errors that do not abort the batch.
- Duplicate detection surfaced in the UI using the existing perceptual hash.
- Clear handling of very large images and storage-quota failures.
- Consistent EXIF orientation behavior across supported browsers.

### Dataset health

- Automated checks for class imbalance, images with no annotations, tiny
  objects, extreme aspect ratios, and likely split leakage.
- Actionable suggestions rather than a score with no explanation.
- Health snapshots recorded with dataset versions so an export can be audited.

### Sample selection

- A shortlist of images that are likely to improve the model, based on
  descriptor diversity and prediction uncertainty.
- Explanations for why an image is recommended.
- No hidden upload or background computation; selection runs locally on demand.

### Export coverage

- Fixture tests for every exporter across every compatible project type.
- Deterministic file and row ordering.
- CSV formula neutralization and clear escaping rules.
- Export presets for common training pipelines.
- Round-trip import for the OpenLabel JSON archive format.

### Accessibility

- Complete keyboard path for project setup, import, training, review, and
  export.
- Screen-reader pass over the annotation list and canvas alternatives.
- Axe checks in CI for every primary screen.
- User-configurable shortcut bindings with conflict detection.

---

## Mid term (0.4–0.9)

### Model quality and transparency

- More descriptor variants (for example, multi-scale color and texture
  statistics) evaluated against fixed fixtures before adoption.
- Calibration reporting: precision/recall curves in addition to the selected
  operating point.
- Better handling of class imbalance and hard negatives.
- Multiple keypoint layout templates per class instead of one mean pose.
- Improved segmentation refinement, including an interactive mask brush and a
  boundary-aware fallback.
- Multi-label classification for images with more than one valid label.

### Model interchange

- Documented, versioned model bundle format with a migration policy.
- Optional local inference adapters for user-supplied ONNX models, running in a
  worker with no network access. This is an opt-in extension, not a replacement
  for the built-in engine.
- Export of model metadata and metrics alongside datasets for reproducibility.

### Dataset workflow

- Version comparison: membership, class counts, and split changes.
- Safe rename and merge operations for classes, with annotation remapping.
- Import from OpenLabel JSON and a documented subset of common annotation
  formats.
- Storage management: per-project usage, unused blobs, and an explicit cleanup
  flow that never deletes the last copy silently.

### Internationalization

- Extract UI strings into `src/locales/`.
- Add right-to-left layout support and locale-aware number formatting.
- Keep documentation English-first; community translations are welcome.

### Performance

- Profile feature extraction and proposal scoring on large images.
- Reduce buffer copies between decode, descriptors, and rendering.
- Bound memory for batch auto-labeling by processing images incrementally.
- Optional Web Worker pool for prediction, preserving deterministic output.

---

## Long term (1.0 and beyond)

### 1.0 stability

- Stable IndexedDB schema with tested migrations.
- Stable model bundle format and exporter contracts.
- Documented compatibility policy for saved projects and exported archives.
- A release process with signed artifacts and a reproducible build check.

### Local model ecosystem

- A small plugin surface for local exporters and local model adapters.
- Reference implementations for common on-device models, all running without a
  network connection after installation.
- Benchmark fixtures and a reproducible comparison harness, so "faster" or
  "better" claims are backed by numbers.

### Optional synchronization

- User-owned synchronization through a storage provider the user configures,
  with end-to-end encryption and conflict resolution. This would be optional and
  outside the default local-only path.
- Never an OpenLabel-hosted account or dataset service.

### Collaborative review without a server

- Local network or peer-to-peer review sessions for teams on the same trusted
  network, with explicit pairing and no silent upload.
- This is exploratory; it must not weaken the default privacy model.

### Accessibility maturity

- External accessibility audit against WCAG 2.2 AA.
- Documented screen-reader test matrix across Chrome, Firefox, and Safari.
- Reduced-motion and high-contrast themes verified in CI.

---

## Explicit non-goals

- A hosted OpenLabel cloud with accounts, billing, or managed datasets.
- Telemetry, session replay, or "anonymous usage analytics" in the core app.
- Requiring a network connection to annotate, train, review, or export.
- Training large neural networks in the browser as the primary workflow.
- Claiming benchmark results without a reproducible dataset and configuration.

---

## How items are chosen

1. **Correctness and privacy first.** A feature that risks local data or
   compromises validation honesty does not ship to chase a metric.
2. **Review bottleneck.** Improvements that reduce the time to review
   auto-labels are usually more valuable than marginal model changes.
3. **Evidence.** Export and model changes need fixtures; performance changes
   need measurements; accessibility changes need keyboard and screen-reader
   verification.
4. **Maintainability.** A smaller, understandable engine is preferred over a
   larger one that is hard to test.

If you want to work on an item, open a discussion or an issue first so the scope
and acceptance criteria are clear. See [CONTRIBUTING.md](../CONTRIBUTING.md).
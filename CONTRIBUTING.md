# Contributing to OpenLabel

Thanks for taking the time to contribute. OpenLabel is a local-first
annotation studio, and every change is expected to preserve that property: no
server, no account, no telemetry, and no upload path for user data.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a
public issue.

---

## Set up the development environment

Requirements:

- Node.js 20.19 or newer; Node 22 LTS is recommended and is what CI uses.
- npm (the repository commits `package-lock.json`).

```bash
git clone https://github.com/Reyn1551/OpenLabel.git
cd openlabel
nvm use            # reads .nvmrc and selects Node 22 when nvm is installed
npm ci             # or: npm install
npm run dev
```

For end-to-end tests, install the Chromium browser once:

```bash
npx playwright install chromium
```

The app uses IndexedDB, Web Workers, `OffscreenCanvas`, and `createImageBitmap`.
Chromium is the primary development target; test Firefox and Safari when a
change touches browser APIs or the canvas.

---

## Scripts

These are the scripts defined in `package.json`. Do not assume others exist.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Vite development server. |
| `npm run build` | Type-check the project and create a production build in `dist/`. |
| `npm run preview` | Serve the production build locally. |
| `npm run typecheck` | Run the configured TypeScript build check. |
| `npm run lint` | Run ESLint over the repository. |
| `npm run test` | Run Vitest unit tests once. |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run test:e2e` | Run the Playwright end-to-end suite. |
| `npm run verify` | Run lint, unit tests, build, and end-to-end tests in sequence. |

Run `npm run verify` before opening a pull request when your machine can run
Playwright. At minimum, run `npm run lint`, `npm run test`, and `npm run build`.

---

## Project layout

- `src/core/`: domain types, IndexedDB access, repositories, geometry, image
  utilities, and dataset exporters. Keep this layer browser-light and testable.
- `src/autolabel/`: the pure few-shot engine: feature grids, anchors, linear
  softmax, polygon refinement, training, validation, and prediction.
- `src/workers/`: Web Worker entry points and message handling.
- `src/features/`: feature-level React screens and state orchestrations.
- `src/ui/`: reusable presentational primitives.
- `src/lib/`: small cross-cutting helpers.
- `src/locales/`: user-facing strings.
- `src/styles/`: Tailwind entry point and design tokens.
- `tests/unit/`: Vitest tests (jsdom environment).
- `tests/e2e/`: Playwright browser tests.

Dependencies flow inward: `core` and `autolabel` must not import from `ui`,
`features`, or React. The worker entry point may import from `core` and
`autolabel`, but the engine itself must stay DOM-free except where image
decoding is explicitly isolated.

---

## Coding standards

- TypeScript strict mode. No `any`; use `unknown` and narrow it. Avoid type
  assertions unless an external API or the DOM forces your hand.
- Named exports only. No default exports.
- Prefer small, pure functions in `core` and `autolabel`. Keep DOM access in
  components, worker adapters, or image helpers that need it.
- Reuse existing types from `src/core/types.ts`. Do not create a parallel
  geometry or annotation model.
- Use `@/` for imports from `src/`.
- Match the surrounding style: two-space indentation, LF line endings, single
  quotes, semicolons, and trailing commas in multiline literals.
- No new runtime dependency without a clear justification in the pull request.
  The engine is intentionally dependency-free; keep it that way unless there is
  a strong reason not to.
- Do not add `console.log` noise. Use the existing error and progress channels.
- Avoid large main-thread pixel loops. Training and prediction belong in the
  auto-label worker; canvas rendering belongs on the main thread.
- Do not introduce a network request for core annotation, training, or storage
  behavior. The existing user-initiated URL import is the only outbound request
  path; any new network path needs an explicit privacy and security review.

ESLint is the source of truth for lint rules. If a rule needs to be disabled,
scope the disable to the smallest possible line and explain why.

---

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(<scope>): <short imperative summary>

<optional body>

<optional footer>
```

Common types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`,
`ci`, `chore`, `revert`.

Suggested scopes: `autolabel`, `core`, `annotator`, `export`, `dataset`,
`a11y`, `ci`, `docs`.

Examples:

```text
feat(export): add YOLO-seg polygon rows
fix(autolabel): keep background row out of class index mapping
perf(annotator): avoid redrawing unchanged overlays
docs(autolabel): document the F1 threshold sweep
```

Rules:

- Use the imperative mood in the subject line.
- Keep the subject under 72 characters; put detail in the body.
- Reference issues with `Closes #123` or `Refs #123`.
- Mark breaking changes with `!` after the type/scope and a `BREAKING CHANGE:`
  footer.
- One logical change per commit where practical.

### Developer Certificate of Origin

OpenLabel uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/)
instead of a contributor license agreement. Sign off every commit:

```bash
git commit -s -m "feat(export): add COCO keypoint export"
```

The sign-off certifies that you wrote the change or otherwise have the right to
submit it under the project's Apache-2.0 license. Commits without a matching
`Signed-off-by` trailer may be asked to amend before merge.

---

## Accessibility requirements

OpenLabel targets WCAG 2.2 Level AA. Accessibility is part of correctness.

A pull request that changes UI must:

- Be fully operable with a keyboard, including dialogs, menus, class selection,
  shape completion, and canvas navigation.
- Keep focus visible and return focus to a sensible element after closing a
  dialog, popover, or menu.
- Use semantic elements before ARIA. Prefer a native button over a clickable
  `div`.
- Provide an accessible name for every control and icon-only button.
- Not convey meaning by color alone. Class colors are paired with names or
  other identifiers.
- Meet contrast requirements: 4.5:1 for normal text, 3:1 for large text and UI
  boundaries.
- Keep target sizes at least 24×24 CSS px (WCAG 2.2 SC 2.5.8), with adequate
  spacing.
- Respect `prefers-reduced-motion` for non-essential motion.
- Announce asynchronous status, such as training progress or export completion,
  through an ARIA live region.
- Reflow without loss of content at 320 CSS px width and 200% zoom.

Add or update automated axe checks for new screens, and test the affected flow
with a screen reader when possible. Automated checks do not replace manual
review. Include a note in the pull request describing the keyboard path you
exercised.

---

## Testing expectations

- **Pure logic** in `core` and `autolabel` needs unit tests. Cover edge cases:
  empty datasets, one class, tiny boxes, zero-area polygons, one image, and
  invalid geometry.
- **Persistence** changes need tests for create/read/update/delete behavior and
  for annotation counts staying consistent.
- **Worker protocol** changes need tests that exercise success, error, and
  cancellation paths.
- **React components** should use Testing Library and assert user-visible
  behavior, not implementation details.
- **Canvas interactions** need Playwright tests when the behavior cannot be
  tested meaningfully in jsdom.
- **Auto-label changes** should include a small deterministic fixture and report
  metric changes in the pull request. Do not "fix" a metric by weakening the
  validation split.
- Tests must be deterministic: no real network, no wall-clock dependence, and
  no reliance on browser-specific pixel output unless the test is explicitly a
  visual or canvas test.

Name unit tests `*.test.ts` or `*.test.tsx` under `tests/unit/`. Name Playwright
specs `*.spec.ts` under `tests/e2e/`.

---

## How to add an exporter

Exporters live in `src/core/exporters.ts`. The public entry point is
`buildExport(input, format)`, which returns `{ files, warnings }`; `zipExport`
packs the files into a deterministic ZIP. The caller constructs an `ExportInput`
with the project, images, annotations, split resolver, preprocessing and
augmentation settings, an `includeImages` flag, and a `loadBlob` callback.

Serializers must not open IndexedDB, mutate their input, or touch the DOM
directly. Image rendering goes through the existing augment/preprocess helpers;
label and manifest generation is deterministic.

To add a format:

1. Add the identifier to the `ExportFormat` union and to the format list the
   export dialog offers.
2. Implement a serializer that returns `ExportFile[]` with stable paths and
   deterministic ordering. Use forward slashes, avoid absolute paths, and
   sanitize any path component derived from a file or class name.
3. Wire the format into the `switch` in `buildExport` and reuse the planned
   variants so preprocessing, augmentation, splits, and duplicate names behave
   consistently with the other formats.
4. Handle every supported geometry explicitly:
   - boxes use source-pixel coordinates and must be converted to the format's
     coordinate convention;
   - polygons must be closed or normalized according to the format's rules;
   - keypoints must follow the class skeleton order, including visibility when
     the format supports it;
   - classification projects use one image-level label.
5. Decide what to do with unsupported annotations. Prefer a `warning` or a
   failed export with an actionable message over silently dropping labels. If a
   format requires a lossy conversion, document it in the format description
   and surface it in the export UI. CSV-like formats must neutralize cells that
   begin with `=`, `+`, `-`, or `@` to prevent spreadsheet formula injection.
6. Add unit tests with a small fixture covering every supported geometry,
   multiple classes, a split, augmented variants, and an empty project where
   relevant. Assert exact file paths and representative file contents.
7. Update the export table in `README.md` and any format notes in `docs/`.
8. Run `npm run lint`, `npm run test`, and `npm run build`.

Exports must be deterministic for the same input. Sort files and rows by a
stable key rather than relying on object insertion order. The ZIP timestamp is
fixed for this reason; do not introduce wall-clock values into exported files.

---

## Pull request checklist

Before requesting review:

- [ ] The change is scoped to one problem and does not include unrelated
      refactors.
- [ ] `npm run lint` passes.
- [ ] `npm run test` passes.
- [ ] `npm run build` passes.
- [ ] `npm run test:e2e` passes when UI or browser behavior changed.
- [ ] New behavior has tests; bug fixes include a regression test.
- [ ] Public APIs and user-visible behavior are documented.
- [ ] Keyboard and screen-reader behavior were considered and noted.
- [ ] No secrets, private datasets, generated build output, or dependency
      directories are committed.
- [ ] Commits use Conventional Commits and include a DCO sign-off.
- [ ] The change preserves local-first behavior: no new server, account,
      telemetry, or upload path.

In the description, explain the problem, the approach, the tests you ran, and
any known limitations. For auto-label changes, include project type, dataset
size, and the metric delta.

---

## Review and merge

- CI must pass on Node 22.
- A maintainer reviews for correctness, maintainability, accessibility, and
  local-first constraints.
- Review comments are about the code, not the person. Ask questions early if a
  design decision is unclear.
- Maintainers may squash commits on merge; the DCO sign-off must remain in the
  commit message.

If your change is not mergeable for scope or product-direction reasons, a
maintainer will say so and explain why. That is still useful feedback, not a
judgment of the contribution.
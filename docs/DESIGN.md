# Design system

This is the single source of truth for OpenLabel's visual language and the
research-backed plan for the studio redesign. The token values are implemented in
`src/styles/index.css`; the component rules are implemented in
`src/ui/primitives.tsx`. The "Roadmap" section is the prioritized backlog from
four research passes (competitor IA, community pain, design craft, self-hosting)
— see the citations at the end.

## Principles

1. **The canvas is the product.** Everything else is chrome. The rails and
   toolbar exist to get out of the way, and the annotation surface gets the
   largest hit targets and the clearest focus.
2. **Local-first is a design constraint, not a footnote.** No feature may
   require a network round trip. The "Local-first" badge and the storage meter
   are permanent UI, not an easter egg.
3. **Accessibility is a hard floor.** WCAG 2.2 AA minimum, keyboard-only
   operation of every flow, and a Lighthouse score of 100 in all four categories
   as the release gate.
4. **Density is a setting, not a bug.** Compact / default / comfortable shift
   control size and padding only — never font size.

## Tokens

The palette is expressed in hex (converted from the researched OKLCH targets)
so light and dark share one perceptual scale. Every text pair was checked
against WCAG 2.2 (4.5:1 for text, 3:1 for non-text UI). The method is the WCAG
relative-luminance formula `(L1 + 0.05) / (L2 + 0.05)`, compared unrounded.

### Light — warm paper

Not pure white: `#fff`-on-`#000` at 21:1 blooms (halation), which reads as
smeared, vibrating text over long sessions. A warm off-white keeps reading
comfortable and keeps the elevation ladder intact.

| Token | Value | Purpose |
| --- | --- | --- |
| `--bg` | `#f3f1ed` | page background (L* 95) |
| `--surface` | `#fcfbf8` | cards, panels |
| `--surface-2` | `#eae7e1` | recessed, table head, hover |
| `--surface-3` | `#dedad2` | pressed, wells |
| `--border` | `#d3cec4` | decorative divider only (1.39:1, never a control edge) |
| `--border-strong` | `#8a8377` | control boundary (3.33:1) |
| `--fg` | `#1a1815` | primary text (17.1:1 on surface — halation budget, not 21:1) |
| `--muted` | `#5a544b` | secondary text (7.2:1 on surface) |
| `--accent` | `#0e6e66` | primary action, focus ring (5.9:1 on surface) |
| `--accent-fg` | `#ffffff` | text on the accent (6.1:1) |
| `--accent-subtle` | `#dcefea` | selected rows, accent chips |
| `--success` / `--warning` / `--error` | `#0a6a43` / `#8a5300` / `#b3261e` | status text (6.1–6.4:1 on surface) |
| `--success-bg` / `--warning-bg` / `--error-bg` | `#ddf3e8` / `#fbeeda` / `#fbe4e1` | status chip fills |
| `--draft` | `#ff2e88` | in-progress canvas shapes (see below) |

### Dark — warm graphite

Not pure black: `#000` destroys the elevation ladder (you cannot step down from
it) and causes black-smear during scroll on OLED. A warm graphite at L* 6.4
keeps the ladder and avoids the blue-black that tints every photo cool by
simultaneous contrast.

| Token | Value | Notes |
| --- | --- | --- |
| `--bg` | `#151412` | page background (L* 6.4) |
| `--surface` | `#1c1a17` | 13.2:1 against `--fg` |
| `--surface-2` | `#24221e` | recessed, table head, hover |
| `--surface-3` | `#2d2a25` | pressed, wells |
| `--border` | `#3b3731` | decorative divider (1.56:1) |
| `--border-strong` | `#6f675c` | control boundary (3.31:1) |
| `--fg` | `#e4e0d7` | warm off-white, not `#fff` (13.2:1) |
| `--muted` | `#a8a29a` | secondary text (6.9:1 on surface) |
| `--accent` | `#2fbfac` | 7.6:1 for `--accent-fg` on it |
| `--accent-fg` | `#0c1512` | dark text on the light accent |
| `--accent-subtle` | `#12312c` | selected rows, accent chips |
| `--success` / `--warning` / `--error` | `#5cd08d` / `#e0a63c` / `#ff8079` | status text (7.1–9.0:1 on surface) |
| `--success-bg` / `--warning-bg` / `--error-bg` | `#0f2a1d` / `#2d2210` / `#2e1614` | status chip fills |
| `--draft` | `#ff2e88` | in-progress canvas shapes (see below) |

The full block, including elevation, motion, and control-size tokens, is in
`src/styles/index.css`.

### Accent: why teal, not the AI purple

The previous accent was indigo/violet (`#4f46e5` / `#8b7cff`), which sits in the
hue-245–255 band that the Tailwind default scale made the path of least
resistance — and that every model trained on that corpus reproduces. It reads as
"AI-generated" on sight. Teal (`#0e6e66` / `#2fbfac`) was chosen by elimination:

- **No semantic collision.** It is not success (green), not warning (amber),
  not destructive (red), and not in the 8-class palette — so the accent can
  carry "the thing you are manipulating right now" without ambiguity.
- **Empty territory.** Linear is indigo, Figma/GitHub/Notion/Vercel are blue,
  Datadog purple, Grafana orange, Raycast red. Teal is the one hue the peer set
  has abandoned, and it does not read as "trying to be different."
- **Complementary to photos.** At hue ≈185° it sits opposite the warm
  skin/wood/foliage tones that dominate photographs, so canvas chrome never
  competes with the image and selection handles stay readable over warm
  subjects.

### In-progress shapes: hot magenta + black/white ants

A single-hue draft cannot work: for a stroke to hit 3:1 against black it needs
low luminance, against white it needs high luminance, and against mid-gray it
needs either extreme — no single luminance satisfies all three, and photos
contain the whole range. So the draft is drawn as a **black + white + colour
"sandwich"**: a black halo, a white halo, then the colour on top. For any
background luminance `L`, `max(contrast(white, L), contrast(black, L))` is
minimised at `L = 0.179` → **4.58:1**, so the pair is *guaranteed* ≥4.58:1 on
every possible background. That is a proof, not a taste call, and it is why
Photoshop marquees and Figma's selection are achromatic.

The colour on top is hot magenta `#ff2e88`, deliberately distinct from the teal
accent so "not committed yet" is unambiguous. Magenta is the hue rarest in
natural photographs (after magenta flowers), so it never blends into content;
and because the ants carry the contrast, a magenta-vs-rose misread is cosmetic,
never a lost box. Implemented in `src/features/studio/CanvasStage.tsx`
(`strokeDraft`).

### The 8-class palette: Okabe–Ito

The class colours are the Okabe–Ito colour-blind-safe palette (Wong,
*Nat Methods* 2011), with the teal and black slots swapped out: teal would
collide with the accent and black is invisible on dark photos.

| # | Hex | Role |
| --- | --- | --- |
| 1 | `#d55e00` | ember / vermillion |
| 2 | `#e69f00` | orange |
| 3 | `#f0e442` | yellow |
| 4 | `#3f8f52` | leaf green |
| 5 | `#0072b2` | blue |
| 6 | `#56b4e9` | sky |
| 7 | `#cc79a7` | rose |
| 8 | `#4a5058` | charcoal (unlabeled / other) |

Verified CIE ΔE00 over all 28 pairs: normal-vision min 20.4, deuteranopia min
12.7, protanopia min 13.2 — the ceiling of what 8 hues can do. **Hue is never
the only channel:** every shape also renders its class name (label chip), and
the sidebar swatches carry a `1px inset 0 0 0 var(--border-strong)` ring, so
`#f0e442` (1.28:1 on a light surface) and `#4a5058` (2.13:1 on a dark surface)
still read.

### Type

- UI default **13/20** (`text-sm`), body copy **14/22**, titles 16/24, page
  titles 20/28, dashboard hero 24/32, metric numerals 32/38.
- Three weights only: 400 body, 500 labels/buttons/table headers, 600 titles.
- Numerals in tables, counts, coordinates, and confidence scores use
  `font-variant-numeric: tabular-nums`.

### Density

`compact 28 / default 32 / comfortable 40` row heights, driven by
`[data-density]`. Touch pointers force a 44px minimum control height.

## Component rules

Five button variants: `primary`, `secondary`, `ghost`, `danger`, `link`. Hover
uses an explicit token (`--accent-hover`), never `brightness()`, because the
filter changes the text-to-fill contrast unpredictably.

| Component | States that must exist | One anti-pattern to avoid |
| --- | --- | --- |
| Button | rest, hover, active, focus-visible, disabled, loading | `hover:brightness(110%)` |
| Input / Field | rest, hover, focus, filled, invalid, disabled | placeholder as the only label |
| Tabs | rest, hover, selected, focus-visible | animating the underline's `left/width` |
| Dialog | open, scrollable body, destructive | backdrop blur + scale entrance (Lighthouse cost) |
| Menu | closed, open, hover, focus, disabled, checked | 18–20px rows (fails SC 2.5.8) |
| Badge | neutral, accent, success, warning, error | status by colour alone (SC 1.4.1) |
| Card | rest, hover (only if clickable), focus-within | nested interactive elements with a stretched link |
| Data table | row hover, selected, sorted, empty, loading | zebra + cell borders + hover at once |
| Toast | queued, visible, error/persistent | auto-dismiss under 5s with no pause (SC 2.2.1) |
| Empty state | empty, filtered-to-zero, error | illustration with no next action |
| Focus ring | keyboard focus only | `outline: none` plus a background tint |

### Canvas

Every annotation draws a 2px class-colour stroke with a 2px white halo under it:
`max(contrast(white, X), contrast(black, X)) ≥ 4.61:1` for any photo luminance,
so a shape survives an unknown background. Handles are 8px visible with a 20px
hit radius, and every drag has a single-pointer alternative (arrow keys nudge
1px, Shift = 10px) per SC 2.5.7.

## Motion

Durations: 100ms hover/press, 150ms state, 200ms menu/dialog enter, 250ms
drawer. Only `opacity`, `transform`, `background-color`, `border-color`, `color`,
and `box-shadow` animate — never `width/height/top/left`, never `filter: blur()`,
never `transition: all`. No entrance animation on the LCP element.
`prefers-reduced-motion` collapses everything to 1ms.

## Roadmap (research-backed)

Ranked by impact ÷ effort. Each item names the evidence that motivated it.

| # | Change | Where | Effort | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Review mode: `A` approve / `R` reject, edit tools hidden, reject → requeue, auto-advance | Studio | M | Review is the bottleneck, not drawing (Encord; LS #7102) |
| 2 | Export pre-flight: editable class→id map, per-split counts, blocking validation | Versions | S | Export silently rewrites ids/paths (LS #9366, forum #339) |
| 3 | Keyboard review verbs + a rebindable hotkey section in Settings | Studio, Settings | S | Keyboard-first is requested, then broken (LS #201, forum #48, POTATO arXiv 2212.08620) |
| 4 | Class delete shows blast radius ("412 annotations across 96 images") + merge classes | Studio | S/M | Class ops are dangerous or impossible (LS #734, LabelImg #981) |
| 5 | Global undo that names the action and carries image context | Studio | S | Undo is scoped wrong (CVAT #8873, PR #10984) |
| 6 | Review diff overlay against the last approved version | Studio | M | Nothing shows what changed (CVAT #11204) |
| 7 | Version "Restore into studio" + per-class diff | Versions | M | Nothing is restorable (LS forum #217) |
| 8 | Rail virtualization + blob prefetch + 512px thumbnail cap | Studio | M | Large datasets hit load walls (CVAT #5719, forum #256) |
| 9 | Collab conflict detection with keep-mine / keep-theirs / review-both | Team | M | Concurrent edits overwrite (LS forum #217) |
| 10 | Project archive export/import with a schema version | Settings | S | Self-hosting is a data-integrity ritual (LS upgrade doc) |

### Studio layout (from the competitor IA study)

- **R1 — Collapsible, persisted rails; tools on a vertical rail.** At 1280px the
  two fixed rails eat 45% of the canvas. CVAT splits tools (left) from objects
  (right); Label Studio's panels are collapsible and detachable.
- **R2 — Auto Label is a first-class tool with a visible suggestion queue**, not
  the second tab of the right panel. CVAT's magic wand and Roboflow's Label
  Assist both live in the editor with an explicit accept/reject step.
- **R3 — A project-level Dataset view** (thumbnail grid + facet chips + bulk
  actions); the studio rail becomes a compact filmstrip. Encord's queue and
  Roboflow's dataset search are the models.
- **R4 — Explicit null/empty state** (`N` marks an image null) so "not started"
  and "verified empty" are distinct. Roboflow ships a Mark Null tool and reports
  null coverage separately.
- **R6 — Freeze is a gate that reads Health** and diffs against the previous
  version.
- **R8 — Health charts are filters**, not posters: every bar deep-links to the
  matching images.
- **R11 — Claim is a lease lock** (owner + heartbeat + TTL), not live cursors,
  because a server-free link cannot promise a live channel.

### Deliberately not copied

Visual workflow builders (V7), per-user analytics (Roboflow Insights, Scale
Quality), configurable XML layouts (Label Studio), multi-image grid canvases
(Supervisely), and plugin panels — each is a server-side surface with no
local-first analogue.

## Sources

- WCAG 2.2: SC 1.4.3, 1.4.11, 2.5.8, 2.5.7, 2.4.11, 2.4.13, 2.1.4 —
  https://www.w3.org/WAI/WCAG22/
- W3C APG: Tabs, Dialog, Grid — https://www.w3.org/WAI/ARIA/apg/patterns/
- Vercel Geist typography and colour — https://vercel.com/geist/
- Radix Colors scale — https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale
- Material 3 density — https://m3.material.io/foundations/layout/grids-spacing/density
- GitHub Primer size tokens — https://primer.style/product/primitives/size/
- NN/g: skeleton screens, animation duration, empty states — https://www.nngroup.com/
- Linear: quality, design reset — https://linear.app/now/quality-wednesdays
- Roboflow docs (annotate, keyboard, team, health, versions) —
  https://docs.roboflow.com/datasets/annotate/annotate/use-roboflow-annotate
- Label Studio — https://labelstud.io/guide/labeling
- CVAT — https://docs.cvat.ai/docs/annotation/annotation-editor/
- Encord — https://docs.encord.com/platform-documentation/Annotate/annotate-label-editor/annotate-label-editor-annotate
- Supervisely — https://docs.supervisely.com/labeling/labeling-toolbox/images
- V7 — https://www.v7labs.com/docs/the-review-stage
- FiftyOne — https://docs.voxel51.com/user_guide/app.html
- Scale/Nucleus — https://api-reference.scale.com/docs/pro-or-tasks-tab
- Community: GitHub issues on `HumanSignal/label-studio`, `cvat-ai/cvat`,
  `HumanSignal/labelImg`; Label Studio Discourse; POTATO benchmark
  (arXiv 2212.08620).

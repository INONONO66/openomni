# Desktop shell

Verified on `feat/desktop-shell-frame` (2026-09-07). The console's frame — tab
strip, sidebar, navigation history — with geometry and mechanics matched to
a reference console build, then bent where the
Owner ruled otherwise. Analysis and measurements: `.omo/reports/desktop-shell-port-20260907.md`.

## Ownership

| Layer | Owns |
| --- | --- |
| `apps/desktop/src/main` | `BrowserWindow`: `hiddenInset`, traffic lights at `{x:17,y:14}` (`y = (42 - 14) / 2`: `y` is the lights' TOP and they measure 14pt tall on Darwin 25, so their centre is 21 — the strip's midline and the 28px controls' centre, `7 + 14`; the classic 12pt lights would need 15. `17 + 52 + 12 = 81` is the strip's traffic safe zone), min `400x600`, background by `nativeTheme` (`#0A0A0C` / `#EFEFF0`, same as `--color-sunken`), bounds persisted to `userData/window-bounds.json` 500ms after the last move (never while minimized/maximized), `backgroundThrottling` off until `ready-to-show` then on. `window-bounds.ts` parses the file fail-closed to the default. |
| `apps/desktop/src/renderer/state` | `store.ts`: `sidebarOpen`, `sidebarFloating` (transient, never persisted), `sidebarWidth` (clamped), `route`, `history {entries, cursor}` behind ONE `navigate(place)`; `back/forward/jumpTo`. `toggleSidebar` pins a floating reveal; `at()` dismisses it on any arrival. `shell-preferences.ts`: the two `localStorage` keys `openomni:sidebar-width` / `openomni:sidebar-open`, restored in `useLayoutEffect` before first paint. |
| `apps/desktop/src/renderer/shell` | `session-tree.tsx`: nav routes, the Sessions section with its search toggle, the project → session tree. `use-search.ts`: search state; `⌘K` opens the field. `shortcuts.ts`: the frame's keys as one pure table. |
| `packages/ui` | `tab-strip.tsx` (the one sidebar toggle; zone width == sidebar width), `sidebar.tsx` (`Sidebar` root/provider with its two frame parts as statics, `Sidebar.Gap` + `Sidebar.Container` in three modes + content, reveal intent, edge zone, resize handle), `sidebar-nav.tsx` (`SidebarNav`/`NavItem`, `SidebarSection` with `SectionHeader` + `SectionList`, `SectionSearchInput`, `SidebarFooter`), `tree-row.tsx`, `history-menu.tsx`, tokens in `styles.css`. The barrel (`index.ts`) exports exactly what `apps/desktop` imports (`apps/desktop/test/ui-barrel.test.ts`); every `data-ui` address in `names.ts` is stamped from `UI_NAMES` somewhere in `src` (`test/names.test.ts`). No data vocabulary: it never names a session, project, or route. |

## Geometry (matched to the reference console)

- Tab strip 42px (`--spacing-shell-strip`; `--shell-top` reads it once `[data-tab-strip]` is on `<html>` at boot). Tabs `h-tab-height` (26px) `w-56 rounded-(--radius-card)`.
- Strip controls: the `base` step, a 28px box (`--spacing-control-base`) around a 16px glyph. The toggle is `variant="plain"` (no hover fill: its glyph's bar widening is the hover answer); history/back/forward keep the `ghost` hover.
- INVARIANT: the strip's controls zone is ALWAYS exactly as wide as the sidebar. Pinned: zone and container are both `w-(--sidebar-width)` (live; a resize drag moves both). Collapsed: zone and the hover-reveal overlay panel are both `w-sidebar-overlay`, ONE token (`--spacing-sidebar-overlay`, `styles.css`) that neither component restates, so they are the same number by construction; the trio's right edge (12px in) therefore marks where the overlay's right edge will land (offset only by the overlay's own 8px `left-2` inset). The zone's padding never changes, only its width.
- Widths (decided 2026-09-07): pinned default 240px, min 224, max 330 (`SIDEBAR_WIDTH`, applied whenever `openomni:sidebar-width` is absent or unparseable); overlay/collapsed 240px too. Why 240 and not a compact 224: the collapsed zone's contents need `89 inset + 28 toggle + 4 + (3·28 + 2·4) trio + 12 pad = 225` on darwin, so 224 would clip by a pixel; and at 240 the overlay keeps the pinned column's line breaks, so pinning a reveal does not reflow the rows. The 15px of spacer this leaves between toggle and trio while collapsed is the visible cost.
- Darwin inset: traffic safe zone `--spacing-traffic-safe` 81px (`17 + 52 + 12`) + 8 = `--spacing-strip-inset-darwin` 89px, so the toggle's box starts at x=89 — a 20px gap after the lights. Vertical: the strip has no border or padding (measured 42 tall), controls top 7 → centre 21; lights top 14 + 14/2 → centre 21 (`15a-traffic-lights-before-y15.png` shows y=15 sitting 0.75pt low; `15-traffic-lights.png` the fix).
- Zone layout `[toggle] [spacer] [trio]`, `gap-1`, `pr-3`: the trio (`TabStrip.Trio`, `ml-auto`) is RIGHT-ALIGNED to the sidebar's edge, 12px in, and rides `--sidebar-width` while open; collapsed, the zone's width equals its content so the spacer is zero and the trio sits 4px after the toggle. The trio is ONE node for the window's life (never re-keyed; `test/strip-mount.test.tsx` renders it on a live DOM, collapses and re-opens, and asserts the same element with one mount). It has NO motion of its own — no opacity, no transform, no state attribute: it slides because the zone's width transitions (`--sidebar-width` <-> `--spacing-sidebar-overlay` on `--duration-base` / `--ease-frame`) and `ml-auto` keeps it on the zone's right edge. It never fades.
- Glyphs (measured 2026-09-07 in the reference bundle: `html.js` base `Icon` — `size: 16` default, `viewBox 0 0 16 16`, width/height = size; every path read (`SidebarLeftIcon`, `ChevronLeft/Right/Down`, `Collapse/ExpandChevronIconLarge`) is built from 0.75 radii, i.e. a 1.5-unit line in the 16 box = 1.5px; `IconButton size=medium` = 28 box). Ours, per site:

  | Site | Reference | Ours |
  | --- | --- | --- |
  | Sidebar toggle | 28 box / 16 glyph, 1.5 line (path verbatim) | 28 / 16, verbatim path |
  | Back / forward | 28 / 16, 1.5 (paths verbatim) | 28 / 16, verbatim paths |
  | History clock | 28 / 16 (`ClockOutline`; path not extracted) | 28 / 16, lucide `History` at `glyph-stroke` = `--stroke-glyph` 1.5px (`vector-effect: non-scaling-stroke`, so the 24-grid glyph keeps 1.5px at 16 instead of thinning to 1.33) |
  | Tab `+` | glyph goes through the base `Icon` (default 16); its button box at the tab bar NOT measured | kept `sm`: 24 box / 14 glyph, lucide's own stroke |
  | Nav row icons | base `Icon` default 16; call site NOT measured | 16 in the 28 row, `glyph-stroke` 1.5px |
  | Section / tree chevrons | `ChevronDown` is a 16 box at 1.5; the sidebar's section chevron component NOT identified | kept lucide `ChevronRight` 14 (`size-3.5`), lucide's own stroke; section toggle (search / close) kept `sm` 24 / 14 |

  `glyph-stroke` is spent at the two 16px sites only (`IconButton size="base"`, `NavItem`); the 14px glyphs keep lucide's weight until measured.
- No sidebar header row: the column starts directly under the strip with the nav (Sessions/Inbox/Automations/Memory). Nav rows and tree rows `h-7`; section header `h-8`. The one search entry point is the section header's inline toggle beside "Sessions" (`SectionHeader.Toggle`), plus `⌘K`.
- Motion: `--duration-fast/base/slow` = 150/240/300ms, `--ease-frame` (= the answer curve, `cubic-bezier(0.2,0,0,1)`); the gap and container slide on `base`, the column fades on `fast` with a 40ms arrival delay; the strip's trio slides with the zone's width and NEVER fades (the reference's `1 - 3p` is for a cluster that fades out while leaving and is replaced on arrival; a persistent node running it from both ends blinked 1 -> 0 -> 1, shipped in 5d19bf4b, removed); transitions suppressed while dragging the resize handle and under `prefers-reduced-motion`; `ArrowLeft/Right` on the handle step 8px, `Shift` 32px.
- Radii `--radius-card .5rem`, `--radius-panel .75rem`; `--shadow-panel` (the frame's one shadow); z scale 10/50/350/500/550/600/700.

## Sidebar toggle and hover reveal (matched to Linear)

Measurements: `.omo/reports/sidebar-toggle-ref-20260907.md`. Linear's renderer is remote; the values were read from its cached bundle, so geometry that lives in its atomic CSS is marked as a default.

- ONE toggle (`Sidebar.Toggle`), first in the strip's controls zone after the window controls, in both states; the trio follows it (4px gap collapsed, right-aligned open — Geometry above). `aria-label` flips `Collapse sidebar` / `Expand sidebar`; `aria-expanded` is the PINNED state (a floating reveal still reads collapsed, because a click pins it). The glyph (`Sidebar.Toggle.Icon`, the reference's `SidebarLeftIcon` frame + `<rect x=4 y=5 h=6 rx=.75>`) reads the column's VISIBILITY: its bar is 1.5 wide hidden and 4.5 pinned or revealed, transitioning width on `--duration-base` / `--ease-frame` (reference: 250ms easeOut). Back/forward are the reference's 16px chevron paths (`icons/chevron.tsx`); the clock stays lucide's `History` (path not extracted), drawn at the frame's 1.5px line (Geometry, Glyphs).
- Keyboard: bare `[` toggles the sidebar (measured: Linear's `keyboardShortcut: { key: "[" }`), ignored while typing in a field or editable content. `⌘[` / `⌘]` remain history.
- Width animation: Linear runs a spring (stiffness 420, damping 38, mass 1) that settles in ~240ms; we run `--duration-base` 240ms on `--ease-frame`. Content fade 150ms (measured constant).
- Container modes (`data-mode` on `Sidebar.Container`): `pinned` (open), `hidden` (collapsed, `-translate-x-full`, content `inert`), `overlay` (collapsed + floating: the SAME column, `left-2 bottom-2`, top `--shell-top + 8px`, `w-sidebar-overlay`, `rounded-panel`, hairline, `shadow-panel`, `z-(--z-drawer)`). The gap stays 0 and the strip stays collapsed while floating. The resize handle renders only when pinned.
- Reveal (`createRevealIntent`, `SIDEBAR_REVEAL`): resting on the toggle or the 8px `Sidebar.Edge` zone below the strip arms open after 250ms (measured); leaving every hot zone (toggle, edge, panel) arms close after 300ms (default — Linear closes at once because its hot container is contiguous; ours needs the grace for the strip→panel hop). Escape, any navigation (`at()`: a row click, a nav item, back/forward), and a toggle (which pins) dismiss it. Timers are cancelled whenever the mode changes.
- Overlay inset 8px / radius `--radius-panel` / shadow: not measured in Linear; defaults.

## Where we diverge from the reference console (Owner rulings)

- The strip's zone holds ONE trio in BOTH states: `[sidebar toggle]` … `[history] [back] [forward]`; the toggle never moves into the sidebar (there is no header row), and the trio slides between the toggle's side and the sidebar's edge rather than being two clusters (the reference mounts a second cluster in the sidebar's own top row).
- Navigation history is app-owned, browser semantics: a new navigation truncates forward entries; the same place twice is one entry; the history menu lists the last 20 newest-first with the current marked; `⌘[` / `⌘]` move.
- Sidebar top nav order: Sessions, Inbox, Automations, Memory. Inbox/Automations/Memory render honest empty states — the wire has no data for them yet.
- Section label is "Sessions" (reference: "Threads"); its search is a toggle beside the label that swaps the header into the field (`SectionHeader.Toggle`).
- Session rows are ONE line (title only) in a project → session tree (`role="tree"`, project rows `treeitem` + `aria-expanded`, children in a `group`).

## Deferred: status indicators

The reference console shows per-thread state (idle, in progress, …) on each row. The Owner ruled
(2026-09-07) that we ship WITHOUT any row status indicator for now. When the
session wire carries run state, the indicator returns as a presentation
primitive in `packages/ui` fed by `apps/desktop`; the attention ordering engine
already models the classes it would show.

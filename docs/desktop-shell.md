# Desktop shell

Verified on `feat/desktop-shell-frame` (2026-09-07). The console's frame — tab
strip, sidebar, navigation history — with geometry and mechanics matched to
a reference console build, then bent where the
Owner ruled otherwise. Analysis and measurements: `.omo/reports/desktop-shell-port-20260907.md`.

## Ownership

| Layer | Owns |
| --- | --- |
| `apps/desktop/src/main` | `BrowserWindow`: `hiddenInset`, traffic lights at `{x:16,y:12}`, min `400x600`, background by `nativeTheme` (`#0A0A0C` / `#EFEFF0`, same as `--color-sunken`), bounds persisted to `userData/window-bounds.json` 500ms after the last move (never while minimized/maximized), `backgroundThrottling` off until `ready-to-show` then on. `window-bounds.ts` parses the file fail-closed to the default. |
| `apps/desktop/src/renderer/state` | `store.ts`: `sidebarOpen`, `sidebarFloating` (transient, never persisted), `sidebarWidth` (clamped), `route`, `history {entries, cursor}` behind ONE `navigate(place)`; `back/forward/jumpTo`. `toggleSidebar` pins a floating reveal; `at()` dismisses it on any arrival. `shell-preferences.ts`: the two `localStorage` keys `openomni:sidebar-width` / `openomni:sidebar-open`, restored in `useLayoutEffect` before first paint. |
| `apps/desktop/src/renderer/shell` | `session-tree.tsx`: nav routes, the Sessions section with its search toggle, the project → session tree. `use-search.ts`: search state; `⌘K` opens the field. `shortcuts.ts`: the frame's keys as one pure table. |
| `packages/ui` | `tab-strip.tsx` (the one sidebar toggle), `sidebar.tsx` (provider, gap + fixed container in three modes + content, reveal intent, edge zone, resize handle), `sidebar-nav.tsx`, `tree-row.tsx`, `history-menu.tsx`, tokens in `styles.css`. No data vocabulary: it never names a session, project, or route. |

## Geometry (matched to the reference console)

- Tab strip `h-10` (`--shell-top: 2.5rem`, set by `[data-tab-strip]` on `<html>` at boot). Tabs `h-7 w-56 rounded-(--radius-card)`.
- Sidebar default 240px, min 224, max 330 (`SIDEBAR_WIDTH`). The strip's controls zone is `w-(--sidebar-width)` while open and `w-tab-controls-collapsed` (204px on darwin) while collapsed; its padding (`pl-[76px] pr-3` on darwin) never changes, only its width.
- Sidebar header `h-11`; nav rows and tree rows `h-7`; section header `h-8`.
- Motion: `--duration-fast/base/slow` = 150/240/300ms, `--ease-frame` (= the answer curve, `cubic-bezier(0.2,0,0,1)`); the gap and container slide on `base`, the column fades on `fast` with a 40ms arrival delay; transitions suppressed while dragging the resize handle and under `prefers-reduced-motion`; `ArrowLeft/Right` on the handle step 8px, `Shift` 32px.
- Radii `--radius-card .5rem`, `--radius-panel .75rem`; `--shadow-panel` (the frame's one shadow); z scale 10/50/350/500/550/600/700.

## Sidebar toggle and hover reveal (matched to Linear)

Measurements: `.omo/reports/sidebar-toggle-ref-20260907.md`. Linear's renderer is remote; the values were read from its cached bundle, so geometry that lives in its atomic CSS is marked as a default.

- ONE toggle (`Sidebar.Toggle`), first in the strip's controls zone after the window controls, in both states: `[toggle]` 12px gap `[history] [back] [forward]`. `aria-label` flips `Collapse sidebar` / `Expand sidebar`; `aria-expanded` is the PINNED state (a floating reveal still reads collapsed, because a click pins it). The header holds brand + search only.
- Keyboard: bare `[` toggles the sidebar (measured: Linear's `keyboardShortcut: { key: "[" }`), ignored while typing in a field or editable content. `⌘[` / `⌘]` remain history.
- Width animation: Linear runs a spring (stiffness 420, damping 38, mass 1) that settles in ~240ms; we run `--duration-base` 240ms on `--ease-frame`. Content fade 150ms (measured constant).
- Container modes (`data-mode` on `Sidebar.Container`): `pinned` (open), `hidden` (collapsed, `-translate-x-full`, content `inert`), `overlay` (collapsed + floating: the SAME column, `left-2 bottom-2`, top `--shell-top + 8px`, `rounded-panel`, hairline, `shadow-panel`, `z-(--z-drawer)`). The gap stays 0 and the strip stays collapsed while floating. The resize handle renders only when pinned.
- Reveal (`createRevealIntent`, `SIDEBAR_REVEAL`): resting on the toggle or the 8px `Sidebar.Edge` zone below the strip arms open after 250ms (measured); leaving every hot zone (toggle, edge, panel) arms close after 300ms (default — Linear closes at once because its hot container is contiguous; ours needs the grace for the strip→panel hop). Escape, any navigation (`at()`: a row click, a nav item, back/forward), and a toggle (which pins) dismiss it. Timers are cancelled whenever the mode changes.
- Overlay inset 8px / radius `--radius-panel` / shadow: not measured in Linear; defaults.

## Where we diverge from the reference console (Owner rulings)

- The strip's zone is laid out Linear-style in BOTH states: `[sidebar toggle]` gap `[history] [back] [forward]`; the toggle never moves into the sidebar header.
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

# Desktop shell

Verified on `feat/desktop-capy-shell` (2026-09-07). The console's frame — tab
strip, sidebar, navigation history — with geometry and mechanics matched to
the Capy Nightly console (0.0.0-nightly.20260906.104), then bent where the
Owner ruled otherwise. Analysis and measurements: `.omo/reports/capy-shell-port-20260907.md`.

## Ownership

| Layer | Owns |
| --- | --- |
| `apps/desktop/src/main` | `BrowserWindow`: `hiddenInset`, traffic lights at `{x:16,y:12}`, min `400x600`, background by `nativeTheme` (`#0A0A0C` / `#EFEFF0`, same as `--color-sunken`), bounds persisted to `userData/window-bounds.json` 500ms after the last move (never while minimized/maximized), `backgroundThrottling` off until `ready-to-show` then on. `window-bounds.ts` parses the file fail-closed to the default. |
| `apps/desktop/src/renderer/state` | `store.ts`: `sidebarOpen`, `sidebarWidth` (clamped), `route`, `history {entries, cursor}` behind ONE `navigate(place)`; `back/forward/jumpTo`. `shell-preferences.ts`: the two `localStorage` keys `openomni:sidebar-width` / `openomni:sidebar-open`, restored in `useLayoutEffect` before first paint. |
| `apps/desktop/src/renderer/shell` | `session-tree.tsx`: nav routes, the Sessions section with its search toggle, the project → session tree. `use-search.ts`: search state; `⌘K` opens the field. |
| `packages/ui` | `tab-strip.tsx`, `sidebar.tsx` (provider, gap + fixed container + inert content, resize handle), `sidebar-nav.tsx`, `tree-row.tsx`, `history-menu.tsx`, tokens in `styles.css`. No data vocabulary: it never names a session, project, or route. |

## Geometry (matched to Capy)

- Tab strip `h-10` (`--shell-top: 2.5rem`, set by `[data-tab-strip]` on `<html>` at boot). Tabs `h-7 w-56 rounded-(--radius-card)`.
- Sidebar default 240px, min 224, max 330 (`SIDEBAR_WIDTH`). The strip's control cell is `w-(--sidebar-width) pl-19 pr-2` while open.
- Sidebar header `h-11`; nav rows and tree rows `h-7`; section header `h-8`.
- Motion: `--duration-fast/base/slow` = 150/200/300ms, `--ease-out-quint`; transitions suppressed while dragging the resize handle; `ArrowLeft/Right` on the handle step 8px, `Shift` 32px.
- Radii `--radius-card .5rem`, `--radius-panel .75rem`; z scale 10/50/350/500/550/600/700.

## Where we diverge from Capy (Owner rulings)

- Collapsed strip is laid out Linear-style: `[sidebar toggle]` gap `[history] [back] [forward]`; width is measured, not a constant, on darwin.
- Navigation history is app-owned, browser semantics: a new navigation truncates forward entries; the same place twice is one entry; the history menu lists the last 20 newest-first with the current marked; `⌘[` / `⌘]` move.
- Sidebar top nav order: Sessions, Inbox, Automations, Memory. Inbox/Automations/Memory render honest empty states — the wire has no data for them yet.
- Section label is "Sessions" (Capy: "Threads"); its search is a toggle beside the label that swaps the header into the field (`SectionHeader.Toggle`).
- Session rows are ONE line (title only) in a project → session tree (`role="tree"`, project rows `treeitem` + `aria-expanded`, children in a `group`).

## Deferred: status indicators

Capy shows per-thread state (idle, in progress, …) on each row. The Owner ruled
(2026-09-07) that we ship WITHOUT any row status indicator for now. When the
session wire carries run state, the indicator returns as a presentation
primitive in `packages/ui` fed by `apps/desktop`; the attention ordering engine
already models the classes it would show.

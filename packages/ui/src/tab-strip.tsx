import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { type HistoryEntry, HistoryMenu } from "./history-menu";
import { ChevronIcon } from "./icons/chevron";
import { SidebarToggleIcon } from "./icons/sidebar-toggle";
import { UI_NAMES } from "./names";
import { IconButton } from "./primitives/button";
import { useSidebar } from "./sidebar";

/**
 * The window's top row, as the reference console builds it: a 42px strip that is the drag
 * surface, with a CONTROLS ZONE on the left whose width tracks the sidebar.
 *
 * The zone is the trick: it is ALWAYS exactly as wide as the sidebar. While
 * the sidebar is pinned it is `--sidebar-width` wide, so the tab starts where
 * the main column starts. When the sidebar collapses the zone shrinks to
 * `--spacing-sidebar-overlay`, the width the hover-reveal panel will have —
 * the same token the panel reads — so the trio's place marks where the panel's
 * right edge lands when it appears. Because the zone animates `width` on the
 * same duration and curve as the sidebar gap, the tab slides left in lockstep
 * with the column beneath it. The zone is `[toggle] [spacer] [trio]`, the
 * spacer being the trio's `ml-auto`: the trio is pinned to the zone's right
 * edge 12px in, in both states. The toggle itself never moves, so it is
 * always in the same place under the pointer. Every number is measured
 * (docs/desktop-shell.md).
 *
 * `platform` is a fact about where the OS draws its window controls, not about
 * the data: on darwin the traffic lights own the first 81px and the zone's
 * content starts at 89 (`--spacing-strip-inset-darwin`); elsewhere the OS
 * draws them on the far right and the zone starts at the window's edge.
 */
export function TabStrip({
  title,
  createLabel,
  onCreate,
  platform,
  history,
  trailing,
}: {
  /** The one tab's title. Absent when nothing is open: the tab is not drawn. */
  readonly title?: string | undefined;
  /** The create control's accessible name: what creating means is the app's word. */
  readonly createLabel: string;
  readonly onCreate: () => void;
  readonly platform: WindowPlatform;
  readonly history: HistoryControls;
  readonly trailing?: ReactNode;
}) {
  const { open, mode, onToggle, reveal } = useSidebar();
  return (
    <header
      className="drag-region fixed inset-x-0 top-0 z-(--z-top-bar) flex h-shell-strip w-full shrink-0 items-center bg-sunken"
      data-ui={UI_NAMES.TabStrip}
    >
      <div
        className={`flex h-full shrink-0 items-center gap-1 overflow-hidden transition-[width] duration-base ease-frame group-data-[resizing]/sidebar:duration-0 motion-reduce:transition-none ${
          open ? "w-(--sidebar-width)" : "w-sidebar-overlay"
        } ${ZONE_INSET[platform]}`}
        data-ui={UI_NAMES.TabStripControls}
      >
        {/* The toggle leads. While collapsed it is also a hot zone: resting on
            it reveals the column as an overlay, and clicking it while revealed
            pins the column open. `plain`: the glyph's bar widening on reveal is
            the hover answer, so no fill. */}
        <IconButton
          aria-expanded={open}
          data-ui={UI_NAMES.SidebarToggle}
          label={open ? "Collapse sidebar" : "Expand sidebar"}
          onClick={onToggle}
          onPointerEnter={open ? undefined : reveal.enter}
          onPointerLeave={open ? undefined : reveal.leave}
          size="base"
          variant="plain"
        >
          <SidebarToggleIcon opened={mode !== "hidden"} />
        </IconButton>
        {/* `ml-auto` is the spacer. Re-keyed on open/collapse so the arrive
            transition replays with the zone's width transition. */}
        <div
          className="strip-trio-arrive ml-auto flex items-center gap-1"
          data-ui={UI_NAMES.TabStripTrio}
          key={open ? "open" : "collapsed"}
        >
          <HistoryMenu
            currentId={history.currentId}
            entries={history.entries}
            now={history.now}
            onJump={history.onJump}
          />
          <IconButton disabled={!history.canBack} label="Back" onClick={history.onBack} size="base">
            <ChevronIcon direction="left" />
          </IconButton>
          <IconButton
            disabled={!history.canForward}
            label="Forward"
            onClick={history.onForward}
            size="base"
          >
            <ChevronIcon direction="right" />
          </IconButton>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1 pl-1">
        {title !== undefined && <Tab title={title} />}
        <IconButton label={createLabel} onClick={onCreate} size="sm">
          <Plus />
        </IconButton>
      </div>
      {trailing !== undefined && (
        <div className="flex shrink-0 items-center gap-1 pr-2">{trailing}</div>
      )}
    </header>
  );
}

/** Where the OS draws its window controls; decides the zone's inset. */
export type WindowPlatform = "darwin" | "other";

/** The zone's padding is the same in both states: only its width moves. */
const ZONE_INSET: Record<WindowPlatform, string> = {
  darwin: "pr-3 pl-strip-inset-darwin",
  other: "px-2",
};

/** The main column's navigation history, as the strip's trio reads it. */
export interface HistoryControls {
  readonly entries: readonly HistoryEntry[];
  readonly currentId: string | null;
  /** The wall clock the menu's relative times are measured against. */
  readonly now: number;
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly onJump: (id: string) => void;
}

/**
 * The one tab: a 26px card, not a pill — 8px corners, a hairline, and the raised
 * tone, with the title set at label weight. No status mark: what the column
 * is doing is the column's to say (docs/desktop-shell.md, Deferred).
 */
function Tab({ title }: { readonly title: string }) {
  return (
    <div
      className="flex h-tab-height w-56 min-w-0 shrink select-none items-center rounded-card border-[0.5px] border-line-surface bg-raised px-2.5 font-medium text-fg text-label"
      data-ui={UI_NAMES.Tab}
    >
      <span className="truncate">{title}</span>
    </div>
  );
}

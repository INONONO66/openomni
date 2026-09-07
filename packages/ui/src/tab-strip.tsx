import { ChevronLeft, ChevronRight, PanelLeft, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { type HistoryEntry, HistoryMenu } from "./history-menu";
import { UI_NAMES } from "./names";
import { IconButton } from "./primitives/button";
import { useSidebar } from "./sidebar";

/**
 * The window's top row, as the reference console builds it: a 40px strip that is the drag
 * surface, with a CONTROLS ZONE on the left whose width tracks the sidebar.
 *
 * The zone is the trick. While the sidebar is open it is exactly
 * `--sidebar-width` wide, so the tab starts where the main column starts. When
 * the sidebar collapses the zone shrinks to what the window controls, the
 * sidebar toggle, and the trio need — and because it animates `width` on the
 * same duration and curve as the sidebar gap, the tab slides left in lockstep
 * with the column beneath it. The zone's CONTENT never moves: Linear-style,
 * `[toggle]` gap `[history] [back] [forward]` leads it after the window
 * controls in both states, so the one toggle is always in the same place
 * under the pointer. Every number is measured (docs/desktop-shell.md).
 *
 * `platform` is a fact about where the OS draws its window controls, not about
 * the data: on darwin the traffic lights are inset 76px into the collapsed
 * zone, elsewhere the OS draws them on the far right and the zone starts at
 * the window's edge.
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
  const { open, onToggle, reveal } = useSidebar();
  return (
    <header
      className="drag-region fixed inset-x-0 top-0 z-(--z-top-bar) flex h-10 w-full shrink-0 items-center bg-sunken"
      data-ui={UI_NAMES.TabStrip}
    >
      <div
        className={`flex h-full shrink-0 items-center overflow-hidden transition-[width] duration-base ease-frame group-data-[resizing]/sidebar:duration-0 motion-reduce:transition-none ${
          open ? "w-(--sidebar-width)" : COLLAPSED_WIDTH[platform]
        } ${ZONE_INSET[platform]}`}
        data-ui={UI_NAMES.TabStripControls}
      >
        {/* The toggle leads, a 12px gap, then the trio. While collapsed the
            toggle is also a hot zone: resting on it reveals the column as an
            overlay, and clicking it while revealed pins the column open. */}
        <IconButton
          aria-expanded={open}
          className="mr-3"
          data-ui={UI_NAMES.SidebarToggle}
          label={open ? "Collapse sidebar" : "Expand sidebar"}
          onClick={onToggle}
          onPointerEnter={open ? undefined : reveal.enter}
          onPointerLeave={open ? undefined : reveal.leave}
          size="sm"
        >
          <PanelLeft />
        </IconButton>
        <div className="flex items-center gap-1">
          <HistoryMenu
            currentId={history.currentId}
            entries={history.entries}
            now={history.now}
            onJump={history.onJump}
          />
          <IconButton disabled={!history.canBack} label="Back" onClick={history.onBack} size="sm">
            <ChevronLeft />
          </IconButton>
          <IconButton
            disabled={!history.canForward}
            label="Forward"
            onClick={history.onForward}
            size="sm"
          >
            <ChevronRight />
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

/** Where the OS draws its window controls; decides the collapsed zone's shape. */
export type WindowPlatform = "darwin" | "other";

const COLLAPSED_WIDTH: Record<WindowPlatform, string> = {
  darwin: "w-tab-controls-collapsed",
  other: "w-tab-controls-collapsed-generic",
};

/** The zone's padding is the same in both states: only its width moves. */
const ZONE_INSET: Record<WindowPlatform, string> = {
  darwin: "pr-3 pl-[76px]",
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
 * The one tab: a card, not a pill — 8px corners, a hairline, and the raised
 * tone, with the title set at label weight. No status mark: what the column
 * is doing is the column's to say (docs/desktop-shell.md, Deferred).
 */
function Tab({ title }: { readonly title: string }) {
  return (
    <div
      className="flex h-7 w-56 min-w-0 shrink select-none items-center rounded-card border-[0.5px] border-line-surface bg-raised px-2.5 font-medium text-fg text-label"
      data-ui={UI_NAMES.Tab}
    >
      <span className="truncate">{title}</span>
    </div>
  );
}

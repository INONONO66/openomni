import { createContext, type ReactNode, type RefObject, useContext, useRef } from "react";
import { UI_NAMES } from "./names";

/**
 * The sidebar, as the reference console builds it: an in-flow GAP that reserves the width, a
 * FIXED container that actually slides, and a CONTENT column inside it that
 * fades a beat after the container moves. Three elements rather than one,
 * because they animate three different things: the gap animates width (so the
 * main column reflows), the container animates `translate` (so the slide is
 * composited), and the content animates `opacity` + a short `translate` on a
 * 40ms delay (so the column reads as arriving after its frame does).
 *
 * The width is RUNTIME: `--sidebar-width` is written on the root, read by the
 * gap, the container, and the tab strip's controls zone. While the handle is
 * dragging it is written straight to the style attribute under
 * `requestAnimationFrame`, and React hears about the width once, on release.
 * Every number here is measured from the reference console; see docs/desktop-shell.md.
 */

/** The width the handle may drag between, and where a fresh window starts. */
export const SIDEBAR_WIDTH = { min: 224, max: 330, default: 240 } as const;

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(width)));
}

/** The one motion attribute every frame element reads: reduced motion wins. */
const FRAME_MOTION = "ease-out-quint motion-reduce:transition-none";

interface SidebarState {
  readonly open: boolean;
  readonly width: number;
  readonly onToggle: () => void;
  readonly onWidthCommit: (width: number) => void;
  readonly rootRef: RefObject<HTMLDivElement | null>;
}

const SidebarContext = createContext<SidebarState | null>(null);

export function useSidebar(): SidebarState {
  const state = useContext(SidebarContext);
  if (state === null) throw new Error("useSidebar: no <Sidebar> above this element");
  return state;
}

/** The shell root. Everything in the window — strip, sidebar, main — is inside it. */
export function Sidebar({
  open,
  width,
  onToggle,
  onWidthCommit,
  className = "",
  children,
  ...rest
}: {
  readonly open: boolean;
  readonly width: number;
  /** Open ↔ collapsed. Fired by the header's toggle and the strip's. */
  readonly onToggle: () => void;
  /** The width the Owner released the handle at, already clamped. */
  readonly onWidthCommit: (width: number) => void;
  readonly className?: string;
  readonly children: ReactNode;
} & Omit<React.ComponentPropsWithoutRef<"div">, "className" | "children" | "style">) {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <SidebarContext.Provider value={{ open, width, onToggle, onWidthCommit, rootRef }}>
      <div
        className={`group/sidebar flex h-dvh w-full overflow-hidden bg-sunken pt-(--shell-top) ${className}`}
        data-sidebar-state={open ? "open" : "collapsed"}
        data-ui={UI_NAMES.Sidebar}
        ref={rootRef}
        style={{ "--sidebar-width": `${width}px` } as React.CSSProperties}
        {...rest}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function SidebarGap() {
  return (
    <div
      className={`relative w-(--sidebar-width) shrink-0 transition-[width] duration-base group-data-[sidebar-state=collapsed]/sidebar:w-0 group-data-[resizing]/sidebar:duration-0 group-data-[sidebar-state=collapsed]/sidebar:duration-fast ${FRAME_MOTION}`}
      data-ui={UI_NAMES.SidebarGap}
    />
  );
}

export function SidebarContainer({ children }: { readonly children: ReactNode }) {
  const { open } = useSidebar();
  return (
    <div
      className={`fixed top-(--shell-top) bottom-0 left-0 z-(--z-sidebar) flex w-(--sidebar-width) transition-[translate] duration-base group-data-[sidebar-state=collapsed]/sidebar:-translate-x-full group-data-[resizing]/sidebar:duration-0 group-data-[sidebar-state=collapsed]/sidebar:duration-fast ${FRAME_MOTION}`}
      data-ui={UI_NAMES.SidebarContainer}
    >
      <div
        // `pt-2` is the column's own top breath; under a tab strip the strip
        // already owns that air, so the column starts flush.
        className={`flex h-full min-h-0 min-w-0 flex-1 flex-col pt-2 transition-[opacity,translate] delay-[40ms] duration-base group-data-[sidebar-state=collapsed]/sidebar:-translate-x-4 group-data-[sidebar-state=collapsed]/sidebar:opacity-0 group-data-[sidebar-state=collapsed]/sidebar:delay-0 group-data-[resizing]/sidebar:duration-0 group-data-[sidebar-state=collapsed]/sidebar:duration-[120ms] [[data-tab-strip]_&]:pt-0 ${FRAME_MOTION}`}
        data-ui={UI_NAMES.SidebarContent}
        // A collapsed column is off-screen but still in the tree: `inert` is
        // what takes its rows out of the tab order and the accessibility tree
        // at once, so ⇥ from the strip lands in the main column and not on a
        // row nobody can see.
        inert={!open}
      >
        {children}
      </div>
      <SidebarResizeHandle />
    </div>
  );
}

/** ←/→ step; with Shift, four steps. */
const KEY_STEP = 8;
const KEY_STEP_SHIFT = 32;

/**
 * The grab zone: 16px wide, straddling the sidebar's right edge, with the 1px
 * line drawn by `after:` on the edge itself. The drag never re-renders React:
 * pointer moves write `--sidebar-width` under rAF and the store hears the final
 * width on release. `data-resizing` on the root is what zeroes the frame's
 * transitions for the duration, so the gap, container, content, and strip zone
 * follow the pointer instead of easing toward it.
 */
function SidebarResizeHandle() {
  const { open, width, onWidthCommit, rootRef } = useSidebar();
  const drag = useRef<{ startX: number; startWidth: number; latest: number; frame: number } | null>(
    null,
  );

  const setWidthVar = (value: number) =>
    rootRef.current?.style.setProperty("--sidebar-width", `${value}px`);

  const end = (commit: boolean) => {
    const current = drag.current;
    if (current === null) return;
    drag.current = null;
    if (current.frame !== 0) cancelAnimationFrame(current.frame);
    rootRef.current?.removeAttribute("data-resizing");
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    if (commit) {
      setWidthVar(current.latest);
      onWidthCommit(current.latest);
    } else {
      setWidthVar(current.startWidth);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter (WAI-ARIA separator with valuenow) has no native element; <hr> cannot be operated
    <div
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuenow={width}
      className="focus-ring no-drag absolute inset-y-0 -right-2 w-4 cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-2 after:w-px after:bg-line-surface after:opacity-0 after:transition-quiet hover:after:opacity-100 focus-visible:after:opacity-100 group-data-[resizing]/sidebar:after:opacity-100 after:motion-reduce:transition-none"
      data-ui={UI_NAMES.SidebarResizeHandle}
      onKeyDown={(event) => {
        const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (direction === 0) return;
        event.preventDefault();
        onWidthCommit(
          clampSidebarWidth(width + direction * (event.shiftKey ? KEY_STEP_SHIFT : KEY_STEP)),
        );
      }}
      onPointerCancel={() => end(false)}
      onPointerDown={(event) => {
        if (!open || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        rootRef.current?.setAttribute("data-resizing", "");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        drag.current = { startX: event.clientX, startWidth: width, latest: width, frame: 0 };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current === null) return;
        current.latest = clampSidebarWidth(current.startWidth + event.clientX - current.startX);
        if (current.frame !== 0) return;
        current.frame = requestAnimationFrame(() => {
          current.frame = 0;
          setWidthVar(current.latest);
        });
      }}
      onPointerUp={() => end(true)}
      role="separator"
      // Only a focus stop while there is a width to change: a collapsed
      // sidebar's handle is off-screen with it.
      tabIndex={open ? 0 : -1}
    />
  );
}

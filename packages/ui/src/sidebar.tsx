import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
} from "react";
import { UI_NAMES } from "./names";

/**
 * The sidebar, as Linear builds it: an in-flow GAP that reserves the width, a
 * FIXED container that actually slides, and a CONTENT column inside it that
 * fades a beat after the container moves. Three elements rather than one,
 * because they animate three different things: the gap animates width (so the
 * main column reflows), the container animates `translate` (so the slide is
 * composited), and the content animates `opacity` + a short `translate` on a
 * 40ms delay (so the column reads as arriving after its frame does).
 *
 * The container has three MODES. `pinned`: the sidebar is open and the gap
 * holds its width. `hidden`: collapsed, translated off-screen, its column
 * `inert`. `overlay`: collapsed, but the pointer has rested on the strip's
 * toggle or the window's left edge, so the SAME column floats over the main
 * panel — inset from the strip and the edge, on the panel radius, with the
 * frame's one shadow — until the pointer leaves, Escape, or a navigation.
 * Clicking the toggle while it floats pins it. One column, one component;
 * the mode is a data attribute and a class set, never a second tree.
 *
 * The width is RUNTIME: `--sidebar-width` is written on the root, read by the
 * gap, the container, and the tab strip's controls zone. While the handle is
 * dragging it is written straight to the style attribute under
 * `requestAnimationFrame`, and React hears about the width once, on release.
 * Numbers and delays: docs/desktop-shell.md.
 */

/** The width the handle may drag between, and where a fresh window starts. */
export const SIDEBAR_WIDTH = { min: 224, max: 330, default: 240 } as const;

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(width)));
}

/**
 * Hover intent for the collapsed sidebar, in milliseconds. `open` is Linear's
 * measured rest-before-reveal; `close` is the grace that lets the pointer hop
 * from the strip's toggle down across the 8px inset into the floating panel
 * without the panel vanishing under it.
 */
export const SIDEBAR_REVEAL = { openDelay: 250, closeDelay: 300 } as const;

/** The one motion attribute every frame element reads: reduced motion wins. */
const FRAME_MOTION =
  "ease-frame motion-reduce:transition-none group-data-[resizing]/sidebar:duration-0";

/** The pointer is over a hot zone / has left every hot zone / the decision was made elsewhere. */
interface RevealIntent {
  readonly enter: () => void;
  readonly leave: () => void;
  readonly cancel: () => void;
}

/** The timers the intent schedules on; the window's by default, a fake clock under test. */
export interface RevealTimers {
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const WINDOW_TIMERS: RevealTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The reveal's timing rules, with no DOM in them so they can be asserted by
 * advancing a clock. `enter` while hidden arms the open and disarms a pending
 * close; `leave` disarms a pending open and, if shown, arms the close. Hopping
 * between two hot zones fires leave-then-enter in one frame, so the close a
 * leave armed is cancelled before it can fire: no counter, no zone identity.
 */
export function createRevealIntent(
  shown: () => boolean,
  set: (floating: boolean) => void,
  timers: RevealTimers = WINDOW_TIMERS,
  delays: { readonly openDelay: number; readonly closeDelay: number } = SIDEBAR_REVEAL,
): RevealIntent {
  let opening: unknown = null;
  let closing: unknown = null;
  const disarm = () => {
    if (opening !== null) timers.clearTimeout(opening);
    if (closing !== null) timers.clearTimeout(closing);
    opening = null;
    closing = null;
  };
  return {
    enter: () => {
      if (closing !== null) {
        timers.clearTimeout(closing);
        closing = null;
      }
      if (shown() || opening !== null) return;
      opening = timers.setTimeout(() => {
        opening = null;
        set(true);
      }, delays.openDelay);
    },
    leave: () => {
      if (opening !== null) {
        timers.clearTimeout(opening);
        opening = null;
      }
      if (!shown() || closing !== null) return;
      closing = timers.setTimeout(() => {
        closing = null;
        set(false);
      }, delays.closeDelay);
    },
    cancel: disarm,
  };
}

/** Which of the container's three states the frame is in. */
type SidebarMode = "pinned" | "overlay" | "hidden";

interface SidebarState {
  readonly open: boolean;
  readonly mode: SidebarMode;
  readonly width: number;
  readonly onToggle: () => void;
  readonly onWidthCommit: (width: number) => void;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  /** Pointer enter/leave for the hot zones: the strip's toggle, the edge, the floating panel. */
  readonly reveal: Pick<RevealIntent, "enter" | "leave">;
}

const SidebarContext = createContext<SidebarState | null>(null);

export function useSidebar(): SidebarState {
  const state = useContext(SidebarContext);
  if (state === null) throw new Error("useSidebar: no <Sidebar> above this element");
  return state;
}

/**
 * The shell root. Everything in the window — strip, sidebar, main — is inside
 * it. Its two frame parts are statics: `Sidebar.Gap` (the in-flow spacer) and
 * `Sidebar.Container` (the fixed box that slides); `Console` composes them, and
 * nothing outside this package needs them by any other name.
 */
export function Sidebar({
  open,
  floating,
  width,
  onToggle,
  onFloatingChange,
  onWidthCommit,
  children,
  ...rest
}: {
  readonly open: boolean;
  /** Collapsed, but revealed over the main column by hover. Ignored while open. */
  readonly floating: boolean;
  readonly width: number;
  /** Open ↔ collapsed. Fired by the strip's toggle; while floating, it pins. */
  readonly onToggle: () => void;
  /** The reveal opening after its delay, or closing: by delay, Escape, or a pin. */
  readonly onFloatingChange: (floating: boolean) => void;
  /** The width the Owner released the handle at, already clamped. */
  readonly onWidthCommit: (width: number) => void;
  readonly children: ReactNode;
} & Omit<React.ComponentPropsWithoutRef<"div">, "className" | "children" | "style">) {
  const rootRef = useRef<HTMLDivElement>(null);
  const mode: SidebarMode = open ? "pinned" : floating ? "overlay" : "hidden";

  // The intent reads the LATEST state through refs so one instance lives for
  // the component's life and a re-render never drops a pending timer.
  const latest = useRef({ open, floating, onFloatingChange });
  latest.current = { open, floating, onFloatingChange };
  const intent = useRef<RevealIntent | null>(null);
  if (intent.current === null) {
    intent.current = createRevealIntent(
      () => latest.current.floating,
      (value) => latest.current.onFloatingChange(value),
    );
  }
  const reveal = useRef({
    enter: () => {
      if (!latest.current.open) intent.current?.enter();
    },
    leave: () => intent.current?.leave(),
  }).current;

  // A mode change was decided — a pin, a collapse, Escape, a navigation — so
  // whatever the pointer had armed is void: left alone, an open timer could set
  // `floating` under a sidebar that was pinned meanwhile. While the column
  // floats, Escape dismisses it.
  useEffect(() => {
    intent.current?.cancel();
    if (mode !== "overlay") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") latest.current.onFloatingChange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mode]);
  useEffect(() => () => intent.current?.cancel(), []);

  return (
    <SidebarContext.Provider
      value={{ open, mode, width, onToggle, onWidthCommit, rootRef, reveal }}
    >
      <div
        className="group/sidebar flex h-dvh w-full overflow-hidden bg-sunken pt-(--shell-top)"
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

function SidebarGap() {
  return (
    <div
      className={`relative w-(--sidebar-width) shrink-0 transition-[width] duration-base group-data-[sidebar-state=collapsed]/sidebar:w-0 ${FRAME_MOTION}`}
      data-ui={UI_NAMES.SidebarGap}
    />
  );
}

/**
 * The container per mode. Pinned and hidden share the frame's geometry and
 * differ only in where the slide rests, at the runtime `--sidebar-width`; the
 * overlay leaves the layout: inset `2` (the same 8px the main panel keeps from
 * the chrome) from the strip and the left edge, on the panel radius, over the
 * drawer layer, at `--spacing-sidebar-overlay` — the SAME token the strip's
 * collapsed zone is sized by, so the zone above is exactly as wide as the panel.
 *
 * The three are ONE fixed box whose mode is a class set, so a mode change is a
 * CSS transition on the same node and never a remount: pinning a floating
 * panel glides its inset 8 -> 0, its radius to 0, and its shadow away, while
 * the gap grows in-flow beside it — the panel MORPHS into the column rather
 * than vanishing while a column grows from the edge. Width rides the same
 * transition: the overlay token equals the pinned default, so at 240 nothing
 * moves; a wider pinned column eases from 240 to its width in step with the
 * strip's zone above. A resize drag zeroes all of it (`data-resizing`).
 */
const CONTAINER: Record<SidebarMode, string> = {
  pinned: "top-(--shell-top) left-0 bottom-0 z-(--z-sidebar) w-(--sidebar-width)",
  hidden: "top-(--shell-top) left-0 bottom-0 z-(--z-sidebar) w-(--sidebar-width) -translate-x-full",
  overlay:
    "top-[calc(var(--shell-top)+--spacing(2))] left-2 bottom-2 z-(--z-drawer) w-sidebar-overlay overflow-hidden rounded-panel border-[0.5px] border-line-surface shadow-panel",
};

/**
 * The content per mode. Under a tab strip the pinned column starts flush (the
 * strip owns that air); the floating panel is its own surface and keeps the
 * column's top breath. Hidden fades out at once; arriving waits the 40ms beat.
 */
const CONTENT: Record<SidebarMode, string> = {
  pinned: "delay-[40ms] [[data-tab-strip]_&]:pt-0",
  hidden: "-translate-x-4 opacity-0 delay-0 [[data-tab-strip]_&]:pt-0",
  overlay: "delay-[40ms]",
};

function SidebarContainer({ children }: { readonly children: ReactNode }) {
  const { open, mode, reveal } = useSidebar();
  const hot = open ? {} : { onPointerEnter: reveal.enter, onPointerLeave: reveal.leave };
  return (
    <>
      {/* The 8px strip on the window's left edge that the reveal listens on
          while the sidebar is collapsed. Beside the floating panel, not under
          it, so leaving the panel for the edge keeps it open. */}
      {!open && (
        <div
          className="fixed top-(--shell-top) bottom-0 left-0 z-(--z-drawer) w-2"
          data-ui={UI_NAMES.SidebarEdge}
          {...hot}
        />
      )}
      <div
        // `bg-sunken` in EVERY mode: the box is opaque, so while it morphs between
        // the overlay's inset and the pinned column the main panel growing in
        // beside it never shows through the rows.
        className={`fixed flex bg-sunken transition-[translate,inset,width,border-radius,box-shadow] duration-base ${CONTAINER[mode]} ${FRAME_MOTION}`}
        data-mode={mode}
        data-ui={UI_NAMES.SidebarContainer}
        {...hot}
      >
        <div
          // `pt-2` is the column's own top breath.
          className={`flex h-full min-h-0 min-w-0 flex-1 flex-col pt-2 transition-[opacity,translate] duration-fast ${CONTENT[mode]} ${FRAME_MOTION}`}
          data-ui={UI_NAMES.SidebarContent}
          // A hidden column is off-screen but still in the tree: `inert` is
          // what takes its rows out of the tab order and the accessibility tree
          // at once, so ⇥ from the strip lands in the main column and not on a
          // row nobody can see.
          inert={mode === "hidden"}
        >
          {children}
        </div>
        {/* Only a pinned column has a width to change: the overlay floats at
            the shared overlay token and the hidden one has none to show. */}
        {open && <SidebarResizeHandle />}
      </div>
    </>
  );
}

Sidebar.Gap = SidebarGap;
Sidebar.Container = SidebarContainer;

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
  const { width, onWidthCommit, rootRef } = useSidebar();
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
        if (event.button !== 0) return;
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
      tabIndex={0}
    />
  );
}

import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import { type ReactNode, useEffect, useRef } from "react";
import { UI_NAMES } from "../names";

/**
 * How close to the end still counts as "at the end".
 *
 * Sub-pixel layout means a viewport pinned to the bottom routinely reports a
 * scroll position a fraction short of its own maximum, so an equality test
 * would read as "the reader scrolled up" on the very frame we just pinned. Two
 * pixels is below the height of a single line of any voice in the system, so
 * nothing a reader could deliberately scroll to lands inside it.
 */
const END_EPSILON = 2;

/**
 * DESIGN.md 4/7 — ScrollArea. The named scroll owner: the Root is the bounded
 * box, the Viewport is the only element that scrolls, and the native scrollbar
 * is replaced by a hairline thumb that appears on hover/scroll. Every column
 * that scrolls in the console uses this instead of a bare `overflow-y-auto`.
 *
 * It also owns END-PINNING (`pinToEnd`), because the scroll position is the
 * scroll owner's business and nothing above it can set `scrollTop` on a
 * viewport it does not render.
 */
export function ScrollArea({
  className = "",
  contentClassName = "",
  contentProps,
  pinToEnd,
  children,
}: {
  readonly className?: string;
  readonly contentClassName?: string;
  /**
   * Attributes for the content box — the element a caller's own children are
   * laid out in. It exists so a surface can NAME its column (`data-*`) without
   * wrapping one more div inside the viewport purely to hang an attribute on,
   * which would put a second box between the scroll owner and the content and
   * quietly break any measurement taken across it.
   */
  readonly contentProps?: Record<string, string>;
  /**
   * Keep the END of the content in view: open there, and stay there as content
   * arrives — until the reader scrolls away, which hands control back to them
   * until they return to the end.
   *
   * Opt-in, because it is only correct for a column whose newest material is at
   * the bottom. The session tree's newest material is wherever the ranking put
   * it, so pinning that column would scroll the Owner away from the top-ranked
   * session every time a row changed.
   */
  readonly pinToEnd?: boolean;
  readonly children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = viewport.current;
    if (pinToEnd !== true || box === null) return;

    // Whether the reader is *currently* at the end. Read at scroll time rather
    // than tracked as state, because a re-render between the reader's scroll and
    // the content's growth would resurrect a stale answer and yank the column.
    const atEnd = () => box.scrollHeight - box.clientHeight - box.scrollTop <= END_EPSILON;
    let following = true;

    const toEnd = () => {
      box.scrollTop = box.scrollHeight;
    };
    // Open at the end. A transcript that opens on the oldest turn asks the Owner
    // to scroll to find out what happened, and buries the one row that might be
    // waiting on them.
    toEnd();

    const onScroll = () => {
      following = atEnd();
    };
    box.addEventListener("scroll", onScroll, { passive: true });

    // Observe the CONTENT and the VIEWPORT both. Content growth is the streaming
    // answer; viewport shrinkage is the approval tray docking above the composer
    // and taking height out of the column. Either one moves the end away from
    // the reader, and only the first is a scroll event.
    const observer = new ResizeObserver(() => {
      if (following) toEnd();
    });
    observer.observe(box);
    for (const child of box.children) observer.observe(child);

    return () => {
      box.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [pinToEnd]);

  return (
    <BaseScrollArea.Root className={`min-h-0 ${className}`} data-ui={UI_NAMES.ScrollArea}>
      <BaseScrollArea.Viewport className="focus-ring size-full overscroll-contain" ref={viewport}>
        <div className={contentClassName} {...contentProps}>
          {children}
        </div>
      </BaseScrollArea.Viewport>
      <BaseScrollArea.Scrollbar className="flex w-2 touch-none justify-center p-0.5 opacity-0 transition-quiet data-hovering:opacity-100 data-scrolling:opacity-100">
        <BaseScrollArea.Thumb className="w-1 rounded-full bg-fg-faint" />
      </BaseScrollArea.Scrollbar>
    </BaseScrollArea.Root>
  );
}

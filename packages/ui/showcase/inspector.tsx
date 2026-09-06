import { useEffect, useRef, useState } from "react";
import { Text, Voice } from "../src";

/**
 * Hold Alt/Option and point at anything: the element is outlined and its
 * `data-ui` ancestor chain is printed beside the pointer. Click while Alt is
 * held to copy the chain.
 *
 * ## Why this is showcase-only
 *
 * It is a REVIEW instrument, not a feature. It reads the surface's own
 * addresses and reports them to whoever is looking at the showcase; it changes
 * nothing, and the product has no use for it. Shipping it would put a
 * pointer-move listener and a keyboard hook into every desktop window for the
 * benefit of a reviewer who is not there. So it lives under `showcase/` and
 * `src/index.ts` never exports it — pinned by `test/names.test.tsx`'s sibling
 * assertion in `test/drift.test.ts`.
 *
 * ## Why Alt, and why hold
 *
 * A toggle would be a mode: turned on once, forgotten, and then quietly
 * changing what every subsequent hover does. A held modifier is a state the
 * reviewer's own hand is asserting — the moment they let go, the surface is
 * exactly what it was, and there is no way to leave the instrument running over
 * a screenshot. Alt in particular because it is the one modifier that neither
 * the browser nor this surface binds to anything: ⌘ is the system, ⌃ is the
 * terminal's, ⇧ extends selections, and Alt on its own does nothing here.
 *
 * ## What it looks like
 *
 * Achromatic, in the meta voice, on the same tonal ramp as everything else. It
 * is machine truth about the surface — the same register a tool row's receipt
 * is in — so it takes that voice rather than inventing a fifth one. It spends
 * no accent: the accent means "live claim" in this system, and an inspector is
 * a claim about nothing.
 */

/** The attribute every addressable element carries. */
const NAME_ATTR = "data-ui";

/** The separator between links in the chain, outermost first. */
const CHAIN_SEP = " \u203a ";

/**
 * How far the readout sits from the pointer.
 *
 * Far enough that the cursor's own glyph never covers the first character, and
 * near enough that reading it does not cost a saccade away from the element it
 * describes.
 */
const OFFSET = 14;

interface Probe {
  /** The chain, outermost first: `Turn.Response › ToolGroup › ToolRow.Status`. */
  readonly chain: string;
  /** The hovered element's border box, for the outline and the readout's anchor. */
  readonly box: DOMRect;
  /** Set while the chain has just been copied, so the readout can say so. */
  readonly copied: boolean;
}

/**
 * Walk up from an element collecting every `data-ui` on the way to the root.
 *
 * The NEAREST named ancestor is the subject, and everything above it is
 * context — so the chain is reversed into reading order: outermost first, the
 * hovered element last. That is the direction containment is spoken in
 * ("the status inside the tool row inside the response"), and it puts the
 * element the reviewer is actually pointing at at the end of the line, where
 * the eye lands after reading the path to it.
 */
function chainOf(start: Element): readonly string[] {
  const links: string[] = [];
  let node: Element | null = start.closest(`[${NAME_ATTR}]`);

  while (node !== null) {
    const name = node.getAttribute(NAME_ATTR);
    if (name !== null && name.length > 0) links.push(name);
    node = node.parentElement?.closest(`[${NAME_ATTR}]`) ?? null;
  }

  return links.reverse();
}

export function Inspector() {
  const [probe, setProbe] = useState<Probe | null>(null);
  // The pointer's last position, held in a ref rather than in state: it updates
  // on every mousemove and only the READOUT needs it, so routing it through
  // React would re-render the whole overlay for a value the browser already has.
  const pointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    // One source of truth for "is Alt down". `event.altKey` on the mousemove is
    // the only reading that cannot desync: a keyup that lands while the window
    // is unfocused never arrives, and a boolean tracked from keydown/keyup alone
    // would leave the instrument stuck on after a ⌘-Tab away and back.
    const onMove = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };

      if (!event.altKey) {
        setProbe((was) => (was === null ? was : null));
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;
      const named = target.closest(`[${NAME_ATTR}]`);
      if (named === null) {
        setProbe((was) => (was === null ? was : null));
        return;
      }

      const chain = chainOf(named).join(CHAIN_SEP);
      const box = named.getBoundingClientRect();
      setProbe((was) =>
        // Identity is kept when nothing moved, so a pointer travelling inside
        // one element does not re-render the overlay 60 times a second.
        was !== null && was.chain === chain && was.box.top === box.top && !was.copied
          ? was
          : { chain, box, copied: false },
      );
    };

    // Alt released — including the release that arrives while the pointer is
    // still. Without this the outline would survive until the next mousemove,
    // which is exactly the frame a reviewer is about to screenshot.
    const onKeyUp = (event: KeyboardEvent) => {
      if (!event.altKey) setProbe(null);
    };

    // The window losing focus is a release the keyup never reports.
    const onBlur = () => setProbe(null);

    const onClick = (event: MouseEvent) => {
      if (!event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const named = target.closest(`[${NAME_ATTR}]`);
      if (named === null) return;

      // Alt-click is the instrument's gesture, so the surface's own click must
      // not also fire: Alt-clicking a Disclosure header should copy its address,
      // not collapse the group out from under the reviewer.
      event.preventDefault();
      event.stopPropagation();

      const chain = chainOf(named).join(CHAIN_SEP);
      void navigator.clipboard
        ?.writeText(chain)
        .then(() => {
          setProbe({ chain, box: named.getBoundingClientRect(), copied: true });
        })
        // A denied clipboard permission must not leave the readout claiming a
        // copy that did not happen. It stays on the plain chain instead.
        .catch(() => undefined);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    // Capture, so the gesture is intercepted before the surface's own handlers
    // see it rather than after they have already acted.
    window.addEventListener("click", onClick, { capture: true });

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("click", onClick, { capture: true });
    };
  }, []);

  if (probe === null) return null;

  const { x, y } = pointer.current;
  // The readout is pinned by its LEFT edge when there is room and by its RIGHT
  // edge when there is not, rather than flipped past a guessed width. A chain is
  // as wide as the nesting is deep — eight links run past 700px — so any fixed
  // threshold is wrong for some element on the page, and being wrong here means
  // the name runs off screen and the instrument fails at its one job.
  const nearRight = x > window.innerWidth / 2;
  const flipY = y > window.innerHeight - 60;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-50" data-inspector>
      {/* The outline is a positioned box rather than an `outline` on the element
          itself: writing a style onto the surface under review would make the
          instrument change the thing it measures, and a 1px outline on a
          `position: static` element also shifts nothing only by luck. */}
      <span
        className="absolute"
        data-inspector-outline
        style={{
          left: `${probe.box.left}px`,
          top: `${probe.box.top}px`,
          width: `${probe.box.width}px`,
          height: `${probe.box.height}px`,
        }}
      />
      <Voice
        className="absolute rounded-sm px-inset py-0.5"
        data-inspector-readout
        style={{
          left: nearRight ? undefined : `${x + OFFSET}px`,
          right: nearRight ? `${window.innerWidth - x + OFFSET}px` : undefined,
          top: flipY ? undefined : `${y + OFFSET}px`,
          bottom: flipY ? `${window.innerHeight - y + OFFSET}px` : undefined,
          // The chain wraps rather than clipping when it is longer than the room
          // available on its side. A truncated name is worse than a wrapped one:
          // `ToolGroup.Sum…` is not an address anybody can paste.
          maxWidth: `${(nearRight ? x : window.innerWidth - x) - OFFSET * 2}px`,
        }}
        voice="meta"
      >
        {probe.chain}
        {/* The size is the second thing a reviewer asks after the name, and it
            is machine truth in the same register — so it rides the same line,
            one tone quieter, rather than opening a second row. */}
        <Text as="span" level="meta" mono tone="faint">
          {"  "}
          {Math.round(probe.box.width)}×{Math.round(probe.box.height)}
        </Text>
        {probe.copied && (
          <Text as="span" level="meta" mono tone="faint">
            {"  copied"}
          </Text>
        )}
      </Voice>
    </div>
  );
}

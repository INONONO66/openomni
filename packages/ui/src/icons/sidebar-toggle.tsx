import { UI_NAMES } from "../names";

/**
 * The sidebar toggle's glyph: a 16px frame with a bar on its left edge that
 * WIDENS when the column is showing. Measured from the reference console's
 * `SidebarLeftIcon`: the frame path is verbatim; the rect is `x=4 y=5 h=6
 * rx=.75`, width 1.5 closed and 4.5 opened, animated on width with the frame's
 * ease-out. Ours runs the transition on `--duration-base` / `--ease-frame`
 * (the reference's 250ms easeOut, within 10ms), and yields to reduced motion.
 *
 * `opened` is the COLUMN's visibility — pinned open OR revealed as an overlay —
 * not the pinned state alone: the glyph answers what the eye sees, while the
 * button's `aria-expanded` answers what a click would pin. Both are written to
 * the svg so the state is machine-readable without a layout.
 */
export function SidebarToggleIcon({ opened }: { readonly opened: boolean }) {
  return (
    <svg
      aria-hidden="true"
      data-opened={opened}
      data-ui={UI_NAMES.SidebarToggleIcon}
      fill="currentColor"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path clipRule="evenodd" d={FRAME} fillRule="evenodd" />
      <rect
        className="transition-[width] duration-base ease-frame motion-reduce:transition-none"
        height="6"
        rx="0.75"
        width={opened ? BAR_OPENED : BAR_CLOSED}
        x="4"
        y="5"
      />
    </svg>
  );
}

const BAR_CLOSED = 1.5;
const BAR_OPENED = 4.5;

const FRAME =
  "M4.25 2C2.45508 2 1 3.45508 1 5.25V10.75C1 12.5449 2.45508 14 4.25 14H11.75C13.5449 14 15 12.5449 15 10.75V5.25C15 3.45508 13.5449 2 11.75 2H4.25ZM2.5 5.5C2.5 4.39543 3.39543 3.5 4.5 3.5H11.5C12.6046 3.5 13.5 4.39543 13.5 5.5V10.5C13.5 11.6046 12.6046 12.5 11.5 12.5H4.5C3.39543 12.5 2.5 11.6046 2.5 10.5V5.5Z";

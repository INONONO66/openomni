import { Button as BaseButton } from "@base-ui/react/button";
import type { ReactNode } from "react";
import { UI_NAMES } from "../names";

type ButtonVariant = "primary" | "secondary" | "ghost" | "plain";

/**
 * Variants are one plain class map: no cva, no runtime styling library. Base UI
 * owns the button semantics (disabled handling, `data-disabled`); this file owns
 * nothing but classes.
 *
 * `primary` is the one place the accent becomes a fill — a commit action is the
 * only affordance allowed to claim the system's single chroma. `secondary` and
 * `ghost` are achromatic text on the tonal ramp, with no border: an outline
 * around a control is the box this system replaced with whitespace. `plain` is
 * `ghost` without the hover fill — for a control whose glyph already answers
 * the pointer (the sidebar toggle's rect widens on reveal), so a fill behind
 * it would say the same thing twice. Measured: the reference toggle runs
 * `hoverBackgroundColor: transparent`.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90 active:opacity-80 disabled:opacity-40",
  secondary: "bg-raised text-fg hover:bg-hover active:bg-active disabled:text-fg-faint",
  ghost: "text-fg-muted hover:bg-hover hover:text-fg active:bg-active disabled:text-fg-faint",
  plain: "text-fg-muted hover:text-fg active:text-fg disabled:text-fg-faint",
};

/**
 * The icon slot is declared once, here, rather than at every call site: any
 * descendant `svg` is non-interactive and never shrinks, and the glyph takes
 * the size that matches the control step (below) unless the caller sized it
 * explicitly. That is what stops icon geometry from drifting per usage.
 */
const ICON_SLOT = "[&_svg]:pointer-events-none [&_svg]:shrink-0";

const BASE = `focus-ring transition-quiet inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none disabled:pointer-events-none ${ICON_SLOT}`;

/**
 * `base` is the strip's step: a 28px box around a 16px glyph, between `sm` and
 * `md`, at the reference's measured 1.5px line (`glyph-stroke`). The 14px
 * glyphs of `sm` and `md` were not measured and keep lucide's own weight.
 */
type IconButtonSize = "xs" | "sm" | "base" | "md";

/** Box and glyph per step; the glyph rule yields to an explicit `size-*` on the svg. */
const ICON_SIZE: Record<IconButtonSize, string> = {
  xs: "size-control-xs rounded-sm [&_svg:not([class*='size-'])]:size-3",
  sm: "size-control-sm rounded-sm [&_svg:not([class*='size-'])]:size-3.5",
  base: "size-control-base rounded-sm [&_svg:not([class*='size-'])]:size-4 [&_svg]:glyph-stroke",
  md: "size-control-md rounded-sm [&_svg:not([class*='size-'])]:size-3.5",
};

/**
 * A square control whose only child is a glyph, so `label` is required: an
 * icon-only control cannot be constructed without an accessible name.
 */
export function IconButton({
  label,
  variant = "ghost",
  size = "md",
  className = "",
  children,
  ...rest
}: {
  readonly label: string;
  readonly variant?: ButtonVariant;
  readonly size?: IconButtonSize;
  readonly className?: string;
  readonly children?: ReactNode;
} & Omit<BaseButton.Props, "className" | "children" | "render" | "style" | "aria-label">) {
  return (
    <BaseButton
      aria-label={label}
      className={`${BASE} ${ICON_SIZE[size]} ${VARIANT[variant]} ${className}`}
      data-size={size}
      data-ui={UI_NAMES.IconButton}
      data-variant={variant}
      {...rest}
    >
      {children}
    </BaseButton>
  );
}

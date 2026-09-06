import { Button as BaseButton } from "@base-ui/react/button";
import type { ReactNode } from "react";
import { UI_NAMES } from "../names";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md";

/**
 * DESIGN.md 7 — Button. Variants are one plain class map: no cva, no runtime
 * styling library. Base UI owns the button semantics (disabled handling,
 * `data-disabled`); this file owns nothing but classes.
 *
 * `primary` is the one place the accent becomes a fill — a commit action is the
 * only affordance allowed to claim the system's single chroma. `secondary` and
 * `ghost` are achromatic text on the tonal ramp, with no border: an outline
 * around a control is the box this system replaced with whitespace.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90 active:opacity-80 disabled:opacity-40",
  secondary: "bg-raised text-fg hover:bg-hover active:bg-active disabled:text-fg-faint",
  ghost: "text-fg-muted hover:bg-hover hover:text-fg active:bg-active disabled:text-fg-faint",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-control-sm gap-1.5 rounded-sm px-2 text-micro has-[>svg]:px-1.5",
  md: "h-control-md gap-2 rounded-sm px-3 text-label has-[>svg]:px-2.5",
};

/**
 * The icon slot is declared once, here, rather than at every call site: any
 * descendant `svg` is non-interactive, never shrinks, and takes the size that
 * matches the control step unless the caller sized it explicitly. That is what
 * stops icon geometry from drifting per usage.
 */
const ICON_SLOT =
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5";

const BASE = `focus-ring transition-quiet inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none disabled:pointer-events-none ${ICON_SLOT}`;

export function Button({
  variant = "ghost",
  size = "md",
  className = "",
  children,
  ...rest
}: {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly className?: string;
  readonly children?: ReactNode;
} & Omit<BaseButton.Props, "className" | "children" | "render" | "style">) {
  return (
    <BaseButton
      className={`${BASE} ${SIZE[size]} ${VARIANT[variant]} ${className}`}
      data-size={size}
      // A variant is not a name. The Owner says "the secondary Button", and the
      // variant is already on `data-variant` beside it — giving each variant its
      // own name would make three addresses for one component and none of them
      // would be the one the doc lists.
      data-ui={UI_NAMES.Button}
      data-variant={variant}
      {...rest}
    >
      {children}
    </BaseButton>
  );
}

export type IconButtonSize = ButtonSize;

const ICON_SIZE: Record<IconButtonSize, string> = {
  sm: "size-control-sm rounded-sm",
  md: "size-control-md rounded-sm",
};

/**
 * DESIGN.md 7 — IconButton. A square Button whose only child is a glyph, so
 * `label` is required: an icon-only control cannot be constructed without an
 * accessible name.
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

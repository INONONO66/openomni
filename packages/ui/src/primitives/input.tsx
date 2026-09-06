import { Input as BaseInput } from "@base-ui/react/input";
import { type ReactNode, useId } from "react";
import { UI_NAMES } from "../names";

export type InputSize = "sm" | "md";

/**
 * DESIGN.md 7 — Input. Base UI's Input owns the field wiring; the wrapper
 * `<label>` carries the surface and the focus treatment, so clicking anywhere in
 * the field — including the leading icon slot — focuses the control.
 *
 * The field has no border. It is a tonal step — `raised`, at rest — because a
 * box drawn around a text field is exactly the frame this system spends
 * whitespace to avoid, and a field with NO surface at all is not a field: it is
 * a placeholder floating in a column, with nothing saying it can be typed into.
 * A quiet elevation is the affordance; an icon would be a second one for the
 * same fact. Focus is the accent underline: one chromatic pixel row, only while
 * the field is actually taking input.
 *
 * The label/control pair is bound by an explicit id rather than by nesting:
 * Base UI renders the `<input>` one level down, which no static a11y check can
 * see through.
 */
const SIZE: Record<InputSize, string> = {
  sm: "h-control-sm gap-1.5 px-2 text-meta",
  md: "h-control-md gap-2 px-2.5 text-label",
};

const WRAPPER =
  "flex items-center rounded-sm border-b border-b-transparent bg-raised text-fg-subtle transition-quiet hover:bg-hover focus-within:border-b-accent has-disabled:cursor-not-allowed has-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0";

const CONTROL =
  "min-w-0 flex-1 bg-transparent text-fg outline-none selection:bg-accent selection:text-accent-fg placeholder:text-fg-faint disabled:cursor-not-allowed";

export function Input({
  label,
  size = "md",
  icon,
  className = "",
  id,
  ...rest
}: {
  /** Accessible name. Visually hidden — this system labels fields by placeholder. */
  readonly label: string;
  readonly size?: InputSize;
  readonly icon?: ReactNode;
  readonly className?: string;
  // `size` is the design-system step, so the native HTML `size` attr is omitted.
} & Omit<BaseInput.Props, "className" | "render" | "style" | "aria-label" | "size">) {
  const generatedId = useId();
  const controlId = id ?? generatedId;

  return (
    // The name is on the WRAPPER, which is the field as the Owner sees it: the
    // surface, the focus underline, and the icon slot are all here, and the
    // `<input>` Base UI renders one level down carries none of them.
    <label
      className={`${WRAPPER} ${SIZE[size]} ${className}`}
      data-ui={UI_NAMES.Input}
      htmlFor={controlId}
    >
      <span className="sr-only">{label}</span>
      {icon}
      <BaseInput className={CONTROL} id={controlId} {...rest} />
    </label>
  );
}

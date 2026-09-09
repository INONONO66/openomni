import type { ReactNode } from "react";
import { UI_NAMES } from "../names";

type PanelTone = "bg" | "sunken" | "raised";

type PanelEdge = "none" | "right" | "left" | "box";

const TONE: Record<PanelTone, string> = {
  bg: "bg-bg",
  sunken: "bg-sunken",
  raised: "bg-raised",
};

const EDGE: Record<PanelEdge, string> = {
  none: "",
  right: "border-line border-r",
  left: "border-line border-l",
  box: "overflow-hidden rounded-panel border-[0.5px] border-line",
};

export function Panel({
  tone = "bg",
  edge = "none",
  as: Tag = "div",
  className = "",
  children,
  ...rest
}: {
  readonly tone?: PanelTone;
  readonly edge?: PanelEdge;
  readonly as?: "div" | "aside" | "nav" | "section" | "header" | "main";
  readonly className?: string;
  readonly children?: ReactNode;
} & Omit<React.ComponentPropsWithoutRef<"div">, "className" | "children">) {
  return (
    <Tag className={`${TONE[tone]} ${EDGE[edge]} ${className}`} data-ui={UI_NAMES.Panel} {...rest}>
      {children}
    </Tag>
  );
}

export type TextTone = "fg" | "muted" | "subtle" | "faint" | "accent";
type TextLevel =
  | "display"
  | "title"
  | "heading"
  | "body"
  | "label"
  | "meta"
  | "micro"
  | "overline";

const TEXT_TONE: Record<TextTone, string> = {
  fg: "text-fg",
  muted: "text-fg-muted",
  subtle: "text-fg-subtle",
  faint: "text-fg-faint",
  accent: "text-accent",
};

const TEXT_LEVEL: Record<TextLevel, string> = {
  display: "text-display font-[590]",
  title: "text-title font-[590]",
  heading: "text-heading font-medium",
  body: "text-body",
  label: "text-label",
  meta: "text-meta",
  micro: "text-micro",
  overline: "text-overline font-semibold uppercase",
};

export function Text({
  level = "body",
  tone = "fg",
  mono = false,
  sans = false,
  numeric = false,
  as: Tag = "span",
  className = "",
  children,
  ...rest
}: {
  readonly level?: TextLevel;
  readonly tone?: TextTone;
  /** Machine truth: ids, paths, counts, code. */
  readonly mono?: boolean;
  /** Human prose. Overrides a mono face inherited from the density scope. */
  readonly sans?: boolean;
  /** Tabular figures — for any number that can change in place. */
  readonly numeric?: boolean;
  readonly as?: "span" | "p" | "div" | "h1" | "h2" | "h3" | "li";
  readonly className?: string;
  readonly children?: ReactNode;
} & Omit<React.ComponentPropsWithoutRef<"span">, "className" | "children">) {
  return (
    <Tag
      className={`${TEXT_LEVEL[level]} ${TEXT_TONE[tone]} ${mono ? "font-mono" : ""} ${
        sans ? "font-sans" : ""
      } ${numeric ? "tabular-nums" : ""} ${className}`}
      data-ui={UI_NAMES.Text}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function Caret({ streaming = false }: { readonly streaming?: boolean }) {
  return (
    <span
      aria-hidden
      className={`ml-0.5 inline-block h-3.5 w-[2px] bg-accent align-text-bottom ${
        streaming ? "streaming-caret" : ""
      }`}
      data-caret=""
      data-streaming={streaming}
      data-ui={UI_NAMES.Caret}
    />
  );
}

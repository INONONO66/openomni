import type { ReactNode } from "react";
import { UI_NAMES } from "../names";

export type PanelTone = "bg" | "sunken" | "raised";
/**
 * A hairline is allowed on a COLUMN SPLIT only — the two places where the
 * layout genuinely divides into independently scrolling regions. There is no
 * `top`/`bottom` edge and no card edge: inside a column, structure is
 * whitespace and type weight, never a drawn box.
 */
export type PanelEdge = "none" | "right" | "left";

const TONE: Record<PanelTone, string> = {
  bg: "bg-bg",
  sunken: "bg-sunken",
  raised: "bg-raised",
};

const EDGE: Record<PanelEdge, string> = {
  none: "",
  right: "border-line border-r",
  left: "border-line border-l",
};

/**
 * DESIGN.md 7 — Panel. The structural surface primitive: one of three quiet
 * tones plus an optional column-split hairline. It exists so app layout code
 * can compose columns without naming a color.
 */
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
    // `data-ui` is spread-FIRST, so a caller composing a more specific surface
    // out of Panel can name it — a Panel that IS the console's sidebar should
    // answer to the sidebar's name, not to the primitive's. Every other
    // primitive does the same for the same reason.
    <Tag className={`${TONE[tone]} ${EDGE[edge]} ${className}`} data-ui={UI_NAMES.Panel} {...rest}>
      {children}
    </Tag>
  );
}

export type TextTone = "fg" | "muted" | "subtle" | "faint" | "accent";
export type TextLevel =
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

/**
 * Weight discipline: 400 to read, 500 to interact, 590 to announce. There is no
 * 700 anywhere in the system — past 590 Pretendard stops adding hierarchy and
 * starts adding noise, and the hierarchy this surface needs is already carried
 * by size and spacing.
 */
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

/**
 * DESIGN.md 3 — Text. Binds a type-scale level to a foreground tone so app code
 * never writes a color or a size class.
 *
 * The face is a claim about WHAT THE TEXT IS, and the system now makes both
 * claims explicitly:
 *
 *   - `mono` means "machine truth": ids, counts, durations, paths, code, tool
 *     names, timestamps. Anything whose exact characters matter, or that sits
 *     in a column where alignment carries meaning.
 *   - `sans` means PROSE: a human sentence, written or generated. It reads
 *     faster, sets tighter, and does not pretend a paragraph is tabular data.
 *
 * Both exist because the shell density block sets the mono face on the whole
 * container — that is the correct default for a ledger, and it makes `mono` a
 * no-op in most places, but it also means prose INHERITS a coding face unless
 * something says otherwise. `sans` is that something. Neither is the implicit
 * default: a surface states which kind of text it is showing, and the one it
 * does not state is the one it inherits from its column.
 */
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

/**
 * DESIGN.md 7 — Caret. Marks the tail of streaming output: a state indicator,
 * not decoration. Drawn, never a half-block character — that glyph varies by
 * font and copies into the transcript as garbage when a reader selects text.
 *
 * 2px and accent-toned, where it used to be a 7px muted slab. A 7px bar is the
 * width of a CHARACTER, so it read as a rendered token — one more mono cell at
 * the end of the line — and the eye tried to parse it. At 2px it is
 * unmistakably a cursor: an insertion point, not content. The accent is spent
 * here for the same reason the running dot spends it — this is the system's one
 * claim about right now, at the exact pixel where output is arriving.
 *
 * The blink is conditional, and that is the entire design. A caret that always
 * blinks is decoration and trains the reader to ignore it; a caret that blinks
 * ONLY while tokens are streaming is a live readout, and the moment it goes
 * solid the reader knows the model stopped without reading a word. Under
 * `prefers-reduced-motion` it holds solid and visible (see styles.css) — the
 * position is still marked, it has simply stopped moving.
 */
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

/**
 * DESIGN.md 8 — Rule. The column-split hairline, as a standalone element for
 * the one case Panel cannot cover: a vertical split inside a flex row.
 */
export function Rule({ className = "" }: { readonly className?: string }) {
  return (
    <span aria-hidden className={`block w-px self-stretch bg-line ${className}`} data-ui={UI_NAMES.Rule} />
  );
}

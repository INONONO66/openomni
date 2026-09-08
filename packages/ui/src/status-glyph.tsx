import type { ReactNode } from "react";
import { UI_NAMES } from "./names";
type Tone = "progress" | "attention" | "success" | "destructive" | "muted" | "faint";
type Shape = "spinner" | "ring" | "dot-pulse" | "check" | "cross" | "pause" | "hollow";
const COLOR: Record<Tone, string> = {
  progress: "var(--status-progress)",
  attention: "var(--status-attention)",
  success: "var(--status-success)",
  destructive: "var(--status-destructive)",
  muted: "var(--color-fg-muted)",
  faint: "var(--color-fg-faint)",
};
const SHAPE: Record<Shape, ReactNode> = {
  spinner: <path d="M7 2a5 5 0 1 1-5 5" />,
  ring: <circle cx="7" cy="7" r="5" />,
  "dot-pulse": <circle cx="7" cy="7" fill="currentColor" r="3" />,
  check: <path d="m3 7 3 3 5-6" />,
  cross: <path d="m3 3 8 8m0-8-8 8" />,
  pause: <path d="M5 3v8m4-8v8" />,
  hollow: <circle cx="7" cy="7" r="3" />,
};
export function StatusGlyph(props: {
  readonly tone: Tone;
  readonly shape: Shape;
  readonly size?: "regular" | "compact";
}) {
  return (
    <svg
      aria-hidden="true"
      className={`status-glyph shrink-0 ${props.size === "compact" ? "size-3.5" : "size-4"} ${props.shape === "spinner" ? "status-spinner" : props.shape === "dot-pulse" ? "status-dot-pulse" : props.shape === "check" || props.shape === "cross" ? "status-entrance" : ""}`}
      data-size={props.size ?? "regular"}
      data-shape={props.shape}
      data-tone={props.tone}
      data-ui={UI_NAMES.StatusGlyph}
      fill="none"
      key={props.shape}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      vectorEffect="non-scaling-stroke"
      style={{ color: COLOR[props.tone] }}
      viewBox="0 0 14 14"
    >
      {SHAPE[props.shape]}
    </svg>
  );
}

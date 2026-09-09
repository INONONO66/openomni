import { useId } from "react";
import { UI_NAMES } from "../names";

export type StateTier = "live" | "attention" | "settled";

const TONE: Record<StateTier, string> = {
  /** The only tier that gets the system's one chroma. */
  live: "text-accent",
  attention: "text-fg-subtle",
  settled: "text-fg-faint",
};

export type StatusShape = "pulse" | "ring" | "filled" | "slashed";

export function StatusDot({
  shape,
  tier,
}: {
  readonly shape: StatusShape;
  readonly tier: StateTier;
}) {
  const maskId = `status-slash-${useId()}`;

  return (
    <span
      aria-hidden="true"
      className={`inline-flex w-[2ch] shrink-0 items-center justify-start ${TONE[tier]}`}
      data-drawn-mark=""
      data-ui={UI_NAMES.StatusDot}
    >
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden decoration; the status word beside it is the readout */}
      <svg
        aria-hidden
        className={shape === "pulse" ? "status-dot-pulse" : undefined}
        data-status-dot={shape === "pulse" ? "running" : shape}
        fill="none"
        height="6"
        viewBox="0 0 6 6"
        width="6"
      >
        
        <circle
          cx="3"
          cy="3"
          fill={shape === "ring" ? "none" : "currentColor"}
          mask={shape === "slashed" ? `url(#${maskId})` : undefined}
          r={shape === "ring" ? 2 : 2.5}
          stroke={shape === "ring" ? "currentColor" : "none"}
          strokeWidth="1"
        />
        
        {shape === "slashed" ? (
          <>
            <mask id={maskId}>
              <rect fill="white" height="6" width="6" x="0" y="0" />
              <path
                d="M0.75 5.25 L5.25 0.75"
                stroke="black"
                strokeLinecap="round"
                strokeWidth="2"
              />
            </mask>
            <path
              d="M0.75 5.25 L5.25 0.75"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1"
            />
          </>
        ) : null}
      </svg>
    </span>
  );
}

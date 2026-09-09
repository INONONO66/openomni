/** Decorative SVG dots; callers supply the accessible state word. CSS owns reduced motion. */
import { UI_NAMES } from "../names";

const DOTS: readonly (readonly [number, number])[] = [
  [3.5, 2.5],
  [3.5, 5],
  [3.5, 7.5],
  [6.5, 7.5],
  [6.5, 5],
  [6.5, 2.5],
];

export function Spinner({
  word,
  className = "",
}: {
  
  readonly word?: string;
  readonly className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 ${className}`}
      data-spinner
      data-ui={UI_NAMES.Spinner}
    >
      {/* One cell wide, matching the character column it sits in, so a row does
          not change width when its tool goes live. */}
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden decoration; the word beside it is the name */}
      <svg aria-hidden className="spinner-dots size-3 shrink-0 text-fg-faint" viewBox="0 0 10 10">
        {DOTS.map(([cx, cy], index) => (
          <circle
            cx={cx}
            cy={cy}
            data-dot={index}
            fill="currentColor"
            // biome-ignore lint/suspicious/noArrayIndexKey: position IS identity
            key={index}
            r={1}
            style={{ ["--dot" as string]: String(index) }}
          />
        ))}
      </svg>
      
      {word !== undefined && (
        <span className="spinner-word font-mono text-fg-faint text-micro">{word}</span>
      )}
    </span>
  );
}

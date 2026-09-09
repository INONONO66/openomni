import { UI_NAMES } from "../names";

export function EpochRule({
  label,
  meta,
  onJump,
  className = "",
}: {
  /** What boundary this is: `compacted`, `resumed`, `context restored`. */
  readonly label: string;
  /** One qualifying fact — a time, a count. Tabular, one step quieter. */
  readonly meta?: string;
  
  readonly onJump?: () => void;
  readonly className?: string;
}) {
  const content = (
    <>
      {/* The lead-in: a short fixed run, the drawn equivalent of the five cells
          the glyph version printed. `w-8` is 32px — the row step — so the rule
          starts on the same grid every other element in the column lands on. */}
      <Hairline className="w-8 shrink-0" />
      
      <span className="shrink-0 py-0.5 font-mono text-fg-faint text-meta">{label}</span>
      {meta !== undefined && (
        <span className="shrink-0 py-0.5 font-mono text-fg-faint text-micro tabular-nums">
          {meta}
        </span>
      )}
      {/* The run-out fills the remaining measure, so the boundary spans the
          column and the label reads as sitting IN the line. */}
      <Hairline className="min-w-0 flex-1" />
    </>
  );

  const bounds = `max-w-measure ${className}`;

  if (onJump === undefined) {
    return (
      <div
        className={`flex items-center gap-2 ${bounds}`}
        data-epoch-rule
        data-ui={UI_NAMES.EpochRule}
      >
        <hr aria-hidden className="m-0 h-0 w-0 border-0 p-0" />
        {content}
      </div>
    );
  }

  return (
    <div className={`flex ${bounds}`} data-epoch-rule data-ui={UI_NAMES.EpochRule}>
      <hr aria-hidden className="m-0 h-0 w-0 border-0 p-0" />
      <button
        className="focus-ring group/epoch -mx-inset flex min-w-0 flex-1 items-center gap-2 rounded-md px-inset py-1 text-left transition-quiet hover:bg-hover"
        onClick={onJump}
        type="button"
      >
        {content}
      </button>
    </div>
  );
}

function Hairline({ className = "" }: { readonly className?: string }) {
  return <span aria-hidden className={`h-0 border-fg-faint border-t ${className}`} />;
}

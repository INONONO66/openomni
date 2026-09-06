import { useState } from "react";
import { UI_NAMES } from "../names";
import { Spinner } from "../primitives/spinner";
import type { StateTier, StatusShape } from "../primitives/state";
import { StatusDot } from "../primitives/state";
import type { ToolStatus, TranscriptTool } from "./model";
import { Voice } from "./voice";
import { collapses, isLoud, summarize, summaryLabel } from "./work-group";

/**
 * A tool call is ONE LINE.
 *
 * `read  src/auth.ts · 34ms` — the verb, the thing, the cost. That is the whole
 * receipt, and it is a receipt: proof the work happened, kept small enough that
 * a reader can skip a block of them without effort and specific enough that
 * they can be checked when it matters.
 *
 * What is deliberately absent is the entire apparatus the previous transcript
 * had built around this row: no left spine, no right-aligned status column, no
 * fixed-width state cell, no inline buttons. Each of those was drawing a
 * relationship the row's own position already states, and together they turned
 * the cheapest element in the column into its most decorated one.
 *
 * The row indents 16px from the agent's text edge. That indent is the only
 * thing saying "this is subordinate to the answer" and it is enough — a spine
 * drawn down the same 16px says it a second time in ink.
 */

/**
 * The status word, when there is one.
 *
 * A settled successful call prints NOTHING here: `done` on every row is a
 * column of the word "done", which is the least informative column a transcript
 * can have. The word appears exactly when the row is making a claim the reader
 * has to act on or wait for.
 */
const WORD: Record<Exclude<ToolStatus, "done">, string> = {
  running: "running",
  // The transcript row does NOT offer the decision. It reports that one is
  // outstanding and the tray above the composer owns the two buttons — one
  // place to approve a call, and it is the one that does not scroll away.
  waiting: "waiting for approval",
  failed: "failed",
  denied: "denied",
};

/**
 * The row's mark, in the design system's own shape/tier vocabulary.
 *
 * `running` is absent because it takes the `Spinner` instead: it is the one
 * state where something is actively arriving, and the one place motion is
 * allowed. The other three are static claims and take a static mark.
 */
const MARK: Record<
  Exclude<ToolStatus, "done" | "running">,
  {
    readonly shape: StatusShape;
    readonly tier: StateTier;
  }
> = {
  // Hollow: the decision has not been filled in yet.
  waiting: { shape: "ring", tier: "attention" },
  failed: { shape: "filled", tier: "settled" },
  denied: { shape: "slashed", tier: "settled" },
};

/**
 * Only a live claim takes the system's one chroma — and `waiting` is not one.
 *
 * `running` is a claim about RIGHT NOW: something is arriving as the reader
 * looks at it, and that is the accent's first reserved role.
 *
 * `waiting for approval` is a claim about a decision, and the decision does not
 * live on this row — it lives in the tray docked above the composer, where
 * `Approve` holds the screen's one accent fill. Colouring the row as well
 * splits that signal across two places and points the loudest one at the
 * element that cannot be acted on. The row reports; the tray acts.
 */
const LIVE: ReadonlySet<ToolStatus> = new Set<ToolStatus>(["running"]);

/**
 * The chevron column, and the SINGLE OWNER of the tool block's text x.
 *
 * Every line inside a tool group — the collapsed summary and every row under it
 * — opens with this slot, so `6 tools` and `shell` land on one left edge. That
 * was the defect: the summary was a bare button with no slot, so it started
 * 12px left of the rows it summarised and the block read as two columns that
 * had drifted apart.
 *
 * 12px because the chevron is drawn on a 12-unit grid (see the SVG below). The
 * value is written once, here, and both call sites take it from `SLOT` — a
 * second literal is how the two edges silently separate again.
 */
const SLOT = "flex w-3 shrink-0 justify-start self-center";

/**
 * The chevron itself, drawn.
 *
 * Drawn on a 12-unit grid rather than pulled from an icon set: a library's
 * 24-unit chevron scales its 2px stroke down to 1px at this size and comes out
 * thinner than every hairline beside it. At 12 units, 1.5px is 1.5px.
 *
 * Shared by the row's payload toggle and the group's fold toggle because they
 * are the same affordance — "this line hides something, open it" — and two
 * hand-drawn chevrons at the same size in one block is two chances to differ.
 */
function Chevron({ open }: { readonly open: boolean }) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden; the button carries the name
    <svg
      aria-hidden
      className={`size-3 transition-quiet ${open ? "rotate-90" : ""}`}
      fill="none"
      height="12"
      viewBox="0 0 12 12"
      width="12"
    >
      <path
        d="M4.5 2.5 L8 6 L4.5 9.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function ToolRow({
  call,
  anchor,
  expanded,
  onToggle,
}: {
  readonly call: TranscriptTool;
  readonly anchor: string;
  readonly expanded: boolean;
  readonly onToggle: (id: string) => void;
}) {
  const payload = call.payload ?? [];
  const openable = payload.length > 0;
  const status = call.status;

  return (
    <div
      className="group/tool"
      data-anchor={anchor}
      data-tool-row={call.id}
      data-ui={UI_NAMES.ToolRow}
    >
      <div className="flex items-baseline gap-cell">
        {/* The chevron holds its 12px column whether or not it is a control, so
            a row with a payload and a row without share one text x. A slot that
            collapses when empty would make every openable row sit 12px further
            right than its neighbours and the block would comb. */}
        <span className={SLOT} data-tool-slot>
          {openable && (
            <button
              aria-expanded={expanded}
              aria-label={`${expanded ? "hide" : "show"} ${call.tool} output`}
              className="focus-ring -m-1 rounded-sm p-1 text-fg/40 transition-quiet hover:text-fg/70"
              onClick={() => onToggle(call.id)}
              type="button"
            >
              <Chevron open={expanded} />
            </button>
          )}
        </span>
        <Voice className="min-w-0 flex-1 truncate" voice="meta">
          {call.tool}
          {"  "}
          <span className="text-fg/55">{call.target}</span>
          {call.duration !== undefined && <span className="text-fg/40"> · {call.duration}</span>}
          {status !== undefined && (
            <>
              {" · "}
              {/* The dot rides WITH the word, inline, after the row's text —
                  not in a reserved column at the row's edge. A column of dots
                  is a second axis to scan; a dot beside the word it qualifies
                  is read in the same fixation as the word. */}
              <span
                className={LIVE.has(status) ? "text-accent" : "text-fg/70"}
                // The mark and the word are ONE address. They are one signal
                // shown twice and they must never be tuned apart — an Owner
                // note about the status of a row has to land on both.
                data-ui={UI_NAMES.ToolRowStatus}
              >
                {status === "running" ? (
                  <Spinner />
                ) : (
                  <StatusDot shape={MARK[status].shape} tier={MARK[status].tier} />
                )}
                {WORD[status]}
              </span>
            </>
          )}
        </Voice>
      </div>
      {openable && expanded && (
        // The payload is CODE, one voice down from prose, indented past the
        // chevron so it hangs under the row's text rather than under its
        // control.
        <pre className="ms-[calc(var(--spacing-cell)+12px)] mt-1 overflow-x-auto whitespace-pre font-mono text-[13px]/[20px] text-fg/70">
          {payload.join("\n")}
        </pre>
      )}
    </div>
  );
}

/**
 * A run of adjacent calls.
 *
 * Rows sit 2px apart — tighter than any other gap in the column, because
 * adjacency in time is the thing this block is asserting and a looser gap would
 * make six receipts read as six separate events.
 *
 * At four rows the block folds to its summary. What it may never fold away is
 * any row that is running, waiting, failed, or denied: those stay visible under
 * the summary line, so the collapsed state can report `6 tools` and still show
 * the one that needs the Owner. A fold that could hide a blocked call would
 * make the quiet state a lie.
 */
export function ToolGroup({
  calls,
  anchorFor,
  expandedIds,
  onToggle,
  elapsed,
  className = "",
}: {
  readonly calls: readonly TranscriptTool[];
  readonly anchorFor: (call: TranscriptTool) => string;
  readonly expandedIds: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  /** The group's total, when every call in it has finished. */
  readonly elapsed?: string;
  /**
   * The gap above the group, from the spacing law.
   *
   * Required in practice even though it defaults: a group that dropped it sat
   * flush against whatever preceded it, which is how the first tool block in a
   * turn lost its 16px pair gap and read as part of the prompt above it.
   */
  readonly className?: string;
}) {
  const foldable = collapses(calls);
  const [open, setOpen] = useState(false);
  const folded = foldable && !open;
  const shown = folded ? calls.filter(isLoud) : calls;

  return (
    <div
      className={`ms-4 flex flex-col gap-[2px] ${className}`}
      data-tool-group
      data-ui={UI_NAMES.ToolGroup}
    >
      {foldable && (
        // The summary takes the SAME chevron slot as the rows beneath it, with a
        // real drawn chevron in it — it IS the group's expand toggle, so the slot
        // is occupied rather than merely reserved. That shared slot is what puts
        // `6 tools` and `shell` on one left edge; without it the summary started
        // 12px left of everything it summarised and the block read as two
        // columns that had drifted apart.
        <button
          aria-expanded={open}
          className="focus-ring flex items-baseline gap-cell rounded-sm text-left transition-quiet"
          data-group-summary
          data-ui={UI_NAMES.ToolGroupSummary}
          onClick={() => setOpen((was) => !was)}
          type="button"
        >
          <span className={SLOT} data-tool-slot>
            <span className="text-fg/40 transition-quiet">
              <Chevron open={open} />
            </span>
          </span>
          <Voice className="text-fg/55 hover:text-fg/70" voice="meta">
            {summaryLabel(summarize(calls), elapsed)}
          </Voice>
        </button>
      )}
      {shown.map((call) => (
        <ToolRow
          anchor={anchorFor(call)}
          call={call}
          expanded={expandedIds.has(call.id)}
          key={call.id}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

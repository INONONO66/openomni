import { useCallback, useState } from "react";
import { UI_NAMES } from "../names";
import { EpochRule } from "../primitives/epoch-rule";
import { anchorId } from "./anchor";
import { MarkdownBlockView } from "./markdown-block";
import type { TranscriptNode, TranscriptTool, TurnCost } from "./model";
import { spacingClass } from "./spacing";
import { ToolGroup } from "./tool-rows";
import { type Turn, type TurnPart, partKind, segmentTurns } from "./turns";

/**
 * The gap that opens a turn — always the largest step in the column, whatever
 * the turn happens to start with. A turn boundary is a turn boundary; deriving
 * it from the first part's kind would give a resumed session that opens on
 * agent output a tighter boundary than a prompted one, for no reason a reader
 * could infer.
 */
/**
 * The turn gap, as the literal class the scanner can see.
 *
 * Routed through `spacingClass` rather than interpolated, so this file has no
 * second way of spelling a gap — see the note on `GAP_CLASS` in `spacing.ts`.
 */
const TURN_GAP_CLASS = spacingClass("prose", "user");

/**
 * The empty expansion set, allocated once.
 *
 * Shared rather than constructed per reset so the identity is stable: a fresh
 * `new Set()` on every render would be a new prop for every tool group and would
 * defeat memoization the moment any of them acquires it.
 */
const EMPTY: ReadonlySet<string> = new Set<string>();

/** Open tool payloads, together with the session they were opened in. */
export type Expansion = { readonly session: string; readonly open: ReadonlySet<string> };

/**
 * The expansion set that applies to `session`, given what is currently held.
 *
 * Split out of the component so the reset rule is testable as a value rather
 * than as a rendered tree — the bug it fixes was invisible in markup, because a
 * stale set only shows up on the SECOND session switch.
 *
 * Returning the shared empty set on a mismatch is what lets the caller detect
 * the reset with an identity check instead of a second comparison.
 */
export function expansionFor(held: Expansion, session: string): ReadonlySet<string> {
  return held.session === session ? held.open : EMPTY;
}
import { Voice } from "./voice";

/**
 * The transcript: ONE centered column, and nothing else.
 *
 * Everything that used to structure this surface has been removed rather than
 * restyled — the worker tree above the turns, the spine down the left of every
 * tool block, the box around the prompt, the right-aligned status column, the
 * inline approve/deny pair, the timestamp on every turn. Each was a mechanism
 * for showing a relationship that the column's own order and indentation
 * already state, and together they made a reading surface look like a dashboard
 * of a reading surface.
 *
 * What is left is the arrangement the reference terminals all converge on and
 * that this system's own premise demands: one chronological stream, three type
 * voices, and whitespace doing the grouping. There are no backgrounds, no
 * borders, and no full-width rules anywhere in this file. The only rule in the
 * column is an `EpochRule`, and it is reserved for a boundary in the ledger —
 * a compaction or a resume — because that is an event, not a separator.
 *
 * Two asymmetries carry the whole conversation:
 *
 *   - **The user's message is right-aligned; the agent's is not.** That single
 *     difference is enough to tell two speakers apart with no label, no avatar,
 *     no fill, and no border. It works because there are exactly two speakers
 *     and one of them is the reader.
 *   - **Tool rows are indented 16px and set 2px apart.** They belong to the
 *     answer above them and they are one block, and the indent plus the tight
 *     stack says both without drawing anything.
 */

export function Timeline({
  nodes,
  costs = {},
  sessionId,
  emptyLabel = "No turns in this session yet.",
}: {
  readonly nodes: readonly TranscriptNode[];
  /** Per-turn time and elapsed, shown on hover or focus only. */
  readonly costs?: Readonly<Record<number, TurnCost>>;
  /** Scopes tool-expansion state, so switching sessions does not carry it. */
  readonly sessionId: string;
  /** The empty state's sentence. The surface's words, with a neutral default. */
  readonly emptyLabel?: string;
}) {
  const turns = segmentTurns(nodes);

  // Which tool payloads are open, per session.
  //
  // "I opened this call's output" is a fact about reading THIS transcript, so it
  // is scoped to the session: carrying it across a switch would open an
  // unrelated row that happens to share an id, and dropping it on every render
  // would close a payload the Owner opened one keystroke ago.
  //
  // The reset COMPARES the session during render rather than running an effect.
  // An effect with an empty dependency list — which is what this was — fires
  // once on mount and never again, so every later session switch carried the
  // previous transcript's open payloads into the new one. Adding `sessionId` to
  // the dependencies would fix that but would paint the new session with the old
  // expansion set for one frame before clearing it. Storing the session
  // alongside the set is the pattern React documents for derived state that has
  // to be correct on the FIRST render after a prop changes.
  const [state, setState] = useState<Expansion>(() => ({ session: sessionId, open: EMPTY }));
  const expanded = expansionFor(state, sessionId);
  if (expanded !== state.open) setState({ session: sessionId, open: expanded });

  const onToggle = useCallback((id: string) => {
    setState((was) => {
      const next = new Set(was.open);
      if (!next.delete(id)) next.add(id);
      return { session: was.session, open: next };
    });
  }, []);

  if (turns.length === 0) {
    return (
      <Voice className="text-fg/40" data-ui={UI_NAMES.Timeline} voice="meta">
        {emptyLabel}
      </Voice>
    );
  }

  return (
    <div className="flex flex-col" data-session={sessionId} data-transcript data-ui={UI_NAMES.Timeline}>
      {turns.map((turn, index) => (
        <TurnView
          cost={costs[turn.index]}
          expanded={expanded}
          first={index === 0}
          key={turn.id}
          onToggle={onToggle}
          turn={turn}
        />
      ))}
    </div>
  );
}

/**
 * The agent-side part kinds — everything in a turn that is NOT the Owner's own
 * message.
 *
 * This is what decides whether a turn has a time at all. It is a set rather than
 * a `!== "user"` check at the one call site because the rule is a claim about
 * the transcript's speakers, and a negation reads as "anything else" rather than
 * as "the agent's side".
 */
const AGENT_PART: ReadonlySet<TurnPart["kind"]> = new Set<TurnPart["kind"]>([
  "prose",
  "tools",
  "epoch",
]);

/**
 * One turn, and the one line that closes its response.
 *
 * The time is the LAST LINE of the agent's block, at rest, flush with the agent
 * text edge — `14:32 · 18s`, wall time then elapsed, in the meta voice. It is
 * not hovered for and it is not positioned absolutely, both of which it was:
 * a fact that only exists while the pointer is inside the turn has no placement
 * to argue about, so revealing it on hover made the Owner's ruling about WHERE
 * it sits unanswerable. Rendered at rest, the placement is the design, and the
 * meta voice at 70% is what keeps it quiet enough to be worth having on screen.
 *
 * It closes the response rather than opening it because that is the reading
 * order of the fact: the answer lands, and then it is stamped. A time above the
 * first paragraph is a header the reader passes through on the way to the
 * content; a time under the last one is a receipt they arrive at when the
 * content is spent.
 *
 * **Never on the Owner's own message.** They were there when they typed it, so a
 * timestamp over a prompt is metadata printed at the one place in the column
 * with no reader for it. A turn that is still only a prompt therefore shows no
 * time at all — there is no elapsed to report until there is a response to have
 * elapsed against.
 */
function TurnView({
  turn,
  cost,
  first,
  expanded,
  onToggle,
}: {
  readonly turn: Turn;
  readonly cost: TurnCost | undefined;
  readonly first: boolean;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
}) {
  let row = 0;
  const nextAnchor = () => {
    row += 1;
    return anchorId(turn.index, row);
  };

  // Whether this turn has an agent side at all. A prompt with no answer yet
  // gets no time, and the check is on the PARTS rather than on the cost, so a
  // cost supplied for a turn that has not been answered still prints nothing.
  const answered = turn.parts.some((part) => AGENT_PART.has(part.kind));

  return (
    <div data-turn={turn.index} data-ui={UI_NAMES.Turn}>
      {turn.parts.map((part, index) => {
        const previous = turn.parts[index - 1];
        // The gap above a part is computed from what precedes it INSIDE the
        // turn. At a turn boundary there is no preceding part, so the law is
        // asked for the boundary gap directly — and the very first part in the
        // column takes none, because a leading margin at the top of a scroll
        // region is dead space paid for on every session open.
        const gap =
          previous === undefined
            ? first
              ? ""
              : TURN_GAP_CLASS
            : spacingClass(partKind(previous), partKind(part));

        return (
          <PartView
            anchor={nextAnchor}
            className={gap}
            expanded={expanded}
            key={part.id}
            onToggle={onToggle}
            part={part}
          />
        );
      })}
      {answered && cost !== undefined && <TurnTime cost={cost} />}
    </div>
  );
}

/**
 * The turn's time: the last line of the agent's block.
 *
 * Flush left with the agent's text edge — not indented to the tool block's 16px
 * and not right-aligned to the measure — because the fact belongs to the answer
 * and the answer's edge is the column's left edge. A right-set time would open a
 * second vertical axis in a column whose entire structure is one left edge.
 *
 * 8px above it is the BLOCK step from the spacing law, taken through
 * `spacingClass` rather than written here: the time is a change of voice inside
 * the turn, exactly like prose meeting a tool block, so it takes the step the
 * law already names for that. Spelling `mt-[8px]` here would be a fifth margin
 * that happens to agree with the law rather than one governed by it.
 *
 * The meta voice already sets 70% foreground; the extra dim to 40% is what makes
 * it recede below the tool rows, which are machine facts the reader may actually
 * need to scan. This one is a fact they will want twice a session.
 */
function TurnTime({ cost }: { readonly cost: TurnCost }) {
  return (
    <Voice
      className={`block text-fg/40 ${TIME_GAP_CLASS}`}
      data-turn-time
      // `Turn.Meta`, not `Turn.Time`: it is the turn's one line of machine truth
      // about itself, and naming it for the clock would leave nowhere to put the
      // next fact that belongs to the same line.
      data-ui={UI_NAMES.TurnMeta}
      voice="meta"
    >
      {cost.at} · {cost.elapsed}
    </Voice>
  );
}

/**
 * The gap above the turn's time, as the literal class the scanner can see.
 *
 * `prose → tools` is the law's BLOCK step: a change of type voice inside one
 * turn. That is precisely what the time is, so it is asked for by kind rather
 * than by number — see the note on `GAP_CLASS` in `spacing.ts` for why this may
 * never be interpolated.
 */
const TIME_GAP_CLASS = spacingClass("prose", "tools");

function PartView({
  part,
  className,
  anchor,
  expanded,
  onToggle,
}: {
  readonly part: TurnPart;
  readonly className: string;
  readonly anchor: () => string;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
}) {
  if (part.kind === "epoch") {
    return (
      <div className={className} data-anchor={anchor()}>
        <EpochRule label={part.label} meta={part.at} />
      </div>
    );
  }

  if (part.kind === "user") {
    // No time here, deliberately and permanently. The Owner does not need to be
    // told when they typed — a timestamp on their own message is metadata
    // printed at the one place in the column that has no reader for it. The
    // turn's clock reading closes the RESPONSE instead, which is the part whose
    // timing is actually a question.
    return (
      // Right-aligned BLOCK, left-aligned TEXT. The block sits on the right so
      // the speaker is unmistakable; the text inside it stays flush left so it
      // is still readable as a paragraph — centered or right-set prose is
      // decoration, and this is something a person wrote.
      //
      // 82% rather than the full measure, so a short message is visibly a
      // message and a long one still reads as prose. At 100% the alignment
      // stops being perceptible on any message that wraps.
      <div
        className={`flex justify-end ${className}`}
        data-anchor={anchor()}
        data-ui={UI_NAMES.TurnPrompt}
        data-user-message
      >
        <div className="flex max-w-[82%] flex-col items-end">
          <Voice className="pb-1 text-fg/40" voice="meta">
            you
          </Voice>
          <Voice as="p" className="whitespace-pre-wrap text-left" voice="prose">
            {part.text}
          </Voice>
        </div>
      </div>
    );
  }

  if (part.kind === "tools") {
    return (
      <ToolGroup
        anchorFor={() => anchor()}
        calls={part.calls}
        className={className}
        elapsed={groupElapsed(part.calls)}
        expandedIds={expanded}
        key={part.id}
        onToggle={onToggle}
      />
    );
  }

  return (
    // `Turn.Response` wraps the agent's block rather than replacing
    // `MarkdownBlock` inside it: the wrapper owns the gap above the block and
    // the block owns the type, and the Owner's two most common notes about this
    // region — "too tight" and "too dim" — land on different elements.
    <div className={className} data-anchor={anchor()} data-ui={UI_NAMES.TurnResponse}>
      <MarkdownBlockView block={part.block} streamingTail={part.streamingTail} />
    </div>
  );
}

/**
 * The group's total, when there is one to report.
 *
 * A group holding an unfinished call has no total: printing one would claim the
 * run finished. Durations arrive pre-formatted, so this only sums when every
 * call reported one and otherwise says nothing.
 */
function groupElapsed(calls: readonly TranscriptTool[]): string | undefined {
  if (calls.some((call) => call.status === "running" || call.status === "waiting")) {
    return undefined;
  }
  const durations = calls.map((call) => call.duration).filter((d): d is string => d !== undefined);
  if (durations.length !== calls.length || durations.length === 0) return undefined;
  return sumDurations(durations);
}

/**
 * Sum pre-formatted durations back into one.
 *
 * The transcript takes durations as strings because formatting them is the
 * surface's decision, and this is the one place that has to do arithmetic on
 * them. It parses the two forms the surface emits and gives up cleanly on
 * anything else — an unsummable group simply prints no total, which is correct,
 * rather than printing a wrong one.
 */
function sumDurations(durations: readonly string[]): string | undefined {
  let ms = 0;
  for (const duration of durations) {
    const match = /^([\d.]+)(ms|s)$/.exec(duration);
    if (match === null) return undefined;
    ms += Number(match[1]) * (match[2] === "s" ? 1000 : 1);
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

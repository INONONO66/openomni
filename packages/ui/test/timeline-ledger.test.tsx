import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { BLOCK_GAP, PAIR_GAP, PARAGRAPH_GAP, TURN_GAP } from "../src/timeline/spacing";
import { Timeline } from "../src/timeline/timeline";
import { segmentTurns } from "../src/timeline/turns";
import { timelines, turnCosts } from "./timeline-fixture";

/**
 * The transcript's reading law, as rendered.
 *
 * These pin what a screenshot shows and a type-check cannot: that the column
 * has no boxes in it, that the streaming cursor is a state readout rather than
 * an ornament, and that the time is absent until it is asked for.
 *
 * The assertions here INVERTED with the rebuild rather than being deleted. They
 * used to require a turn footer under every settled turn and a clock reading on
 * a gapped one; both of those are the permanent-metadata habit the column was
 * rebuilt to remove, so what is pinned now is their absence. That is the
 * stricter direction — "nothing prints a time at rest" fails on more surfaces
 * than "something does" ever did.
 */

/** A session whose last assistant turn is still streaming. */
const STREAMING = "kernel-ledger";

/** A session whose turns are all complete. */
const SETTLED = Object.keys(timelines).find((id) => {
  const nodes = timelines[id] ?? [];
  return (
    nodes.some((node) => node.kind === "assistant") &&
    nodes.every((node) => node.kind !== "assistant" || !node.streaming)
  );
});

function render(id: string): string {
  const nodes = timelines[id];
  if (!nodes) throw new Error(`no timeline fixture for ${id}`);
  return renderToStaticMarkup(
    <Timeline costs={turnCosts[id] ?? {}} nodes={nodes} sessionId={id} />,
  );
}

/**
 * The assistant turns of one fixture, already narrowed. Pulling the narrowing
 * into the predicate is what lets the callers below read `.at`/`.streaming`
 * without a second `kind` check purely to satisfy the union.
 */
function assistantTurns(id: string) {
  return (timelines[id] ?? []).filter((node) => node.kind === "assistant");
}

describe("the transcript ledger", () => {
  test("Given the fixtures, When surveyed, Then both streaming states are represented", () => {
    // Without both, the caret assertions below would pass vacuously.
    expect(assistantTurns(STREAMING).some((node) => node.streaming)).toBe(true);
    expect(SETTLED).toBeDefined();
  });

  test("Given a streaming turn, When rendered, Then the caret marks the tail", () => {
    // The caret is a live readout: it says output is arriving at this exact
    // pixel. It is the one blinking element in the system and it exists only
    // while there is something to blink about.
    expect(render(STREAMING)).toContain("align-text-bottom");
  });

  test("Given a settled turn, When rendered, Then no caret survives", () => {
    // The inverse: a cursor on a finished turn is motion-shaped decoration on
    // a static fact, which is the slop this system forbids.
    if (SETTLED === undefined) throw new Error("no settled fixture");

    expect(render(SETTLED)).not.toContain("align-text-bottom");
  });

  test("Given any turn, When rendered, Then nothing closes it with a footer", () => {
    // The turn footer is gone. It printed a bracketed cost line under every
    // exchange — a permanent row of totals nobody was reading, and the single
    // thing that made the column read as a report rather than a conversation.
    for (const id of Object.keys(timelines)) {
      expect(render(id), id).not.toContain("data-turn-footer");
    }
  });

  test("Given a turn with a cost, When rendered, Then the time is on screen at rest", () => {
    // The Owner's ruling, and the INVERSION of what this test used to assert.
    // The time rode `opacity: 0` until hover, positioned absolutely so the
    // reveal could not reflow. That is deleted: a fact that only exists while
    // the pointer is inside the turn has no resting placement, so a ruling about
    // WHERE it sits could not be satisfied by it. It is visible, and it is kept
    // quiet by type and tone instead — meta voice, dimmed below the tool rows.
    if (SETTLED === undefined) throw new Error("no settled fixture");
    const cost = turnCosts[SETTLED]?.[1];
    if (cost === undefined) throw new Error("no cost fixture");

    const html = render(SETTLED);
    const at = html.indexOf("data-turn-time");
    expect(at).toBeGreaterThanOrEqual(0);

    // Both facts, in the order the Owner named them: wall time, then elapsed.
    expect(html).toContain(`${cost.at} \u00b7 ${cost.elapsed}`);

    // The element itself: no absolute positioning, and nothing that could hide
    // it. `opacity-0` and the hover mechanism are gone from the component AND
    // from the stylesheet — the CSS half is pinned separately below, because
    // removing only one of the two leaves the time invisible with a passing
    // markup assertion.
    const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at));
    expect(tag).not.toContain("absolute");
    expect(tag).not.toContain("opacity-0");
    expect(tag).not.toContain("hidden");

    // The meta voice, dimmed. 12px mono at 70% is what `Voice` sets; the extra
    // dim is what puts it under the tool rows, which are facts a reader may
    // actually scan.
    expect(tag).toContain('data-voice="meta"');
    expect(tag).toContain("text-fg/40");
  });

  test("Given the stylesheet, When read, Then no rule hides the time again", () => {
    // The other half of the ruling, and the half a markup test cannot see. The
    // reveal lived entirely in `styles.css` as `[data-turn] [data-turn-time] {
    // opacity: 0 }`, so the component could render a perfectly correct at-rest
    // line and the stylesheet would still erase it — exactly the shape of the
    // pass 9 defect, where the classes were right and the CSS was missing.
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const rules = css.split(/\/\*[\s\S]*?\*\//).join("");

    expect(rules, "a stylesheet rule targets the turn time again").not.toContain("data-turn-time");
  });

  test("Given an answered turn, When rendered, Then the time is the agent block's LAST line", () => {
    // The placement ruling, stated positionally. The time closes the response:
    // the answer lands, then it is stamped. It used to be rendered on the turn's
    // FIRST agent part, which put it above the first paragraph — a header the
    // reader passes through on the way to the content rather than a receipt they
    // arrive at when the content is spent.
    //
    // Asserted as "nothing follows it inside the turn" rather than as a DOM
    // index, because the turn's children are parts and the time is a sibling of
    // all of them: the fact that matters is that it is LAST, whatever the turn
    // happens to contain.
    if (SETTLED === undefined) throw new Error("no settled fixture");
    const html = render(SETTLED);

    const time = html.indexOf("data-turn-time");
    expect(time).toBeGreaterThanOrEqual(0);

    // Everything the transcript can draw inside a turn, and none of it may open
    // after the time does.
    const after = html.slice(time);
    for (const marker of [
      "data-anchor",
      "data-tool-group",
      "data-tool-row",
      "data-user-message",
      "data-epoch-rule",
    ]) {
      const at = after.indexOf(marker);
      const boundary = after.indexOf("data-turn=");
      // A marker is allowed only if the NEXT turn has already opened before it.
      const ok = at < 0 || (boundary >= 0 && boundary < at);
      expect(ok, `${marker} is drawn after the turn's time`).toBe(true);
    }
  });

  test("Given a user message, When rendered, Then it carries no time element", () => {
    // THE rule the Owner set: the time belongs under the agent's RESPONSE and
    // never on the Owner's own message. A timestamp over a prompt is metadata
    // printed at the one place in the column with no reader for it — the Owner
    // was there when they typed it.
    //
    // This is asserted over EVERY fixture rather than one, because the defect
    // was structural: the time was rendered on the turn CONTAINER and absolutely
    // positioned, so it landed over whatever the turn opened with. For a
    // prompted turn that is always the user block, and no per-fixture check
    // would have said so.
    for (const id of Object.keys(timelines)) {
      const html = render(id);
      let from = html.indexOf("data-user-message");
      expect(from, `${id} has no user message to check`).toBeGreaterThanOrEqual(0);

      while (from >= 0) {
        // The user block is the wrapper div through its closing paragraph — the
        // same span the density gate uses, so both tests agree on what "the
        // user's block" is.
        const block = html.slice(html.lastIndexOf("<div", from), html.indexOf("</p>", from));

        expect(block, `${id} prints a time on the user's own message`).not.toContain(
          "data-turn-time",
        );
        from = html.indexOf("data-user-message", from + 1);
      }
    }
  });

  test("Given a turn with a cost, When rendered, Then the time hangs under the response", () => {
    // The positive half of the rule above. Deleting the user-side render is only
    // half the fix: if the time were dropped entirely the absence assertion
    // would still pass, and the Owner would have lost a fact they asked to keep.
    if (SETTLED === undefined) throw new Error("no settled fixture");
    const html = render(SETTLED);

    const user = html.indexOf("data-user-message");
    const time = html.indexOf("data-turn-time");

    expect(user).toBeGreaterThanOrEqual(0);
    expect(time).toBeGreaterThanOrEqual(0);
    // After the prompt in document order, because it belongs to the answer.
    expect(time).toBeGreaterThan(user);
  });

  test("Given a turn with no answer yet, When rendered, Then it carries no time", () => {
    // There is no elapsed to report until there is a response to have elapsed
    // against. The guard is on the PARTS rather than on the cost, so a cost
    // supplied for an unanswered turn still prints nothing — which is the case
    // a caller can produce by accident and a `cost !== undefined` check alone
    // would happily render.
    const html = renderToStaticMarkup(
      <Timeline
        costs={{ 1: { at: "14:32", elapsed: "18s" } }}
        nodes={[{ kind: "prompt", id: "only", text: "waiting on you" }]}
        sessionId="unanswered"
      />,
    );

    expect(html).toContain("data-user-message");
    expect(html).not.toContain("data-turn-time");
    expect(html).not.toContain("18s");
  });

  test("Given any timeline, When rendered, Then the column draws no box", () => {
    // The load-bearing negative. No backgrounds, no borders, and no full-width
    // rules anywhere in the transcript: whitespace is the only grouping
    // mechanism, and every one of these was a mechanism for saying what the
    // column’s own order already says.
    // Not every fixture has a fence, so the excision is proven across the set
    // rather than per timeline: if the pattern ever stops matching anywhere,
    // this assertion catches it, and a fixture with no fence stays legal.
    let excised = 0;

    for (const id of Object.keys(timelines)) {
      const html = render(id);
      // The code fence is the one element allowed a surface, because a fence is
      // quoted material from somewhere else and needs an edge to be quoted BY.
      const outside = html.split(/<pre[\s\S]*?<\/pre>/).join("");
      // Matched on the fence's NAME rather than on its classes. The old form
      // keyed on `rounded-md border` running to the end of the tag, which broke
      // the moment the element gained a `data-ui` attribute after its class —
      // and broke SILENTLY, by leaking the fence's own legal fill into the
      // region this assertion reads. The name is the stable handle: it is the
      // element's declared address, and `names.test.tsx` fails if it moves.
      const fences = outside.split(/<div [^>]*data-ui="CodeFence"[^>]*>/);
      excised += fences.length - 1;

      for (const region of fences.slice(0, 1)) {
        expect(region, `${id} draws a fill`).not.toMatch(/bg-(raised|sunken|hover|active)/);
      }
      // A drawn hairline in the column is reserved for the epoch rule, which is
      // a ledger EVENT rather than a separator between turns.
      const rules = [...outside.matchAll(/border-t\b/g)].length;
      const epochs = [...outside.matchAll(/data-epoch-rule/g)].length;
      // Two hairlines per epoch rule: the lead-in and the run-out.
      expect(rules, `${id} draws a rule that is not an epoch`).toBe(epochs * 2);
    }

    expect(excised, "the fence excision matched no fence in any timeline").toBeGreaterThan(0);
  });

  test("Given the spacing law, When rendered, Then every gap is one of the four steps", () => {
    // The rhythm IS the layout. A fifth margin in the column is a grouping the
    // reader has to learn, and it would arrive without anyone declaring one.
    // Read from the constants rather than spelled out, so moving a step (28 →
    // 40, as the Owner ruled) does not require editing a second list that would
    // otherwise reject the very gap the law now names.
    const allowed = new Set([TURN_GAP, PAIR_GAP, BLOCK_GAP, PARAGRAPH_GAP].map(String));

    for (const id of Object.keys(timelines)) {
      const gaps = [...render(id).matchAll(/mt-\[(\d+)px\]/g)].map((m) => m[1] ?? "");
      expect(gaps.length, `no gaps in ${id}`).toBeGreaterThan(0);
      for (const gap of gaps) {
        expect(allowed, `unnamed gap ${gap}px in ${id}`).toContain(gap);
      }
    }
  });

  test("Given every part in a turn, When rendered, Then each one carries its gap", () => {
    // The gap is computed correctly and then has to SURVIVE to the element.
    // `ToolGroup` originally took no `className`, so every tool block silently
    // dropped its margin: the law was right, the class was built, and the
    // rendered column still had the first tool block flush against the prompt
    // above it. Counting the gaps against the parts is what catches a branch
    // that forgets to spend one.
    for (const id of Object.keys(timelines)) {
      const nodes = timelines[id] ?? [];
      const turns = segmentTurns(nodes);
      const costs = turnCosts[id] ?? {};
      // Every part except the very first in the column takes a gap...
      const parts = turns.reduce((total, turn) => total + turn.parts.length, 0) - 1;
      // ...and so does every turn's closing time line, which is a change of
      // voice inside the turn and spends the block step like any other. It is
      // counted here rather than excluded from the match, so a time that lost
      // its gap and sat flush against the last paragraph fails this too.
      const times = turns.filter(
        (turn) =>
          costs[turn.index] !== undefined && turn.parts.some((part) => part.kind !== "user"),
      ).length;
      const rendered = [...render(id).matchAll(/mt-\[\d+px\]/g)].length;

      expect(rendered, `${id} dropped a gap`).toBe(parts + times);
    }
  });

  test("Given a turn opening with a tool block, When rendered, Then the pair gap survives", () => {
    // Named separately because it is the case that actually shipped broken, and
    // a count alone would pass if two gaps were wrong in opposite directions.
    const withPair = Object.keys(timelines).find((id) =>
      segmentTurns(timelines[id] ?? []).some(
        (turn) => turn.parts[0]?.kind === "user" && turn.parts[1]?.kind === "tools",
      ),
    );
    if (withPair === undefined) throw new Error("no user-then-tools fixture");

    expect(render(withPair)).toContain("mt-[16px]");
  });

  test("Given the transcript, When rendered, Then no fixed rhythm survives on the container", () => {
    // The gap is a fact about a PAIR, so it can neither be a flex gap on the
    // column nor a fixed margin on every block. A `gap-section` here would
    // apply one number to every pair again, which is the flat rhythm that made
    // a paragraph break look like a turn boundary.
    const html = render(STREAMING);
    const container = html.split("data-transcript")[0]?.split('class="')[1]?.split('"')[0] ?? "";

    expect(container).not.toContain("gap-");
  });
});

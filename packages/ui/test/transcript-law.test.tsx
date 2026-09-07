import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { Console } from "../src/console";
import type { TranscriptNode } from "../src/timeline/model";
import {
  BLOCK_GAP,
  PAIR_GAP,
  PARAGRAPH_GAP,
  type PartKind,
  TURN_GAP,
  gapAbove,
  spacingClass,
} from "../src/timeline/spacing";
import { type Expansion, Timeline, expansionFor } from "../src/timeline/timeline";
import { segmentTurns } from "../src/timeline/turns";
import { COLLAPSE_AFTER, collapses, isLoud, summarize, summaryLabel } from "../src/timeline/work-group";
import { pending, transcript } from "./fixture";

/**
 * The transcript law, pinned where it is DECIDED rather than where it is drawn.
 *
 * Most of what this file asserts is pure: the spacing steps, what splits a tool
 * group, when a group folds and what a fold may never hide. Those are functions,
 * so they are tested as functions — a rendering test for "28px between turns"
 * pins a class string, which is a fact about Tailwind, not about the law.
 *
 * The rendered assertions are the ones that cannot be pure: the accent budget is
 * a claim about the whole screen at once, and it is exactly the kind of thing
 * that erodes one well-argued exception at a time.
 */

describe("the spacing law", () => {
  test("Given the four steps, When compared, Then the ratios carry the grouping", () => {
    // The ORDER is the design. A turn boundary has to beat the gap inside a
    // turn by enough that the eye finds it without reading, and a paragraph
    // break has to sit under the block gap or an answer reads as separate
    // blocks instead of continuous prose.
    expect(TURN_GAP).toBeGreaterThan(PAIR_GAP);
    expect(PAIR_GAP).toBeGreaterThan(BLOCK_GAP);
    expect(BLOCK_GAP).toBeGreaterThan(PARAGRAPH_GAP);
  });

  test("Given the turn step, When measured against the turn's insides, Then it wins by 2.5x", () => {
    // ORDER WAS NOT ENOUGH, and this is the test that says so.
    //
    // The law always claimed a turn boundary must be found "without reading",
    // and the only thing pinning that claim was `TURN_GAP > PAIR_GAP` — which 28
    // satisfied at 1.75x while the rendered column still read the next turn's
    // `you` as the tail of the previous answer. A strict inequality cannot tell
    // a boundary from a slightly wider paragraph break.
    //
    // 2.5x is the ratio the Owner's 40px sets, and pinning the RATIO rather than
    // the number is what keeps this meaningful if the pair gap ever moves: the
    // claim is about the relationship, not about 40.
    const inside = Math.max(PAIR_GAP, BLOCK_GAP, PARAGRAPH_GAP);

    expect(inside).toBe(PAIR_GAP);
    expect(TURN_GAP / inside).toBeGreaterThanOrEqual(2.5);
  });

  test("Given a user message, When it follows anything, Then the turn gap opens above it", () => {
    // A user message always opens a turn, whatever closed the previous one.
    // That is what makes turn boundaries the loudest whitespace in the column.
    expect(gapAbove("prose", "user")).toBe(TURN_GAP);
    expect(gapAbove("tools", "user")).toBe(TURN_GAP);
    expect(gapAbove("user", "user")).toBe(TURN_GAP);
  });

  test("Given a response, When it follows a user message, Then the pair gap binds them", () => {
    // Visibly tighter than a turn, so the response reads as belonging to the
    // prompt above it rather than floating between two turns.
    expect(gapAbove("user", "prose")).toBe(PAIR_GAP);
    expect(gapAbove("user", "tools")).toBe(PAIR_GAP);
  });

  test("Given two paragraphs, When adjacent, Then the smallest step keeps them continuous", () => {
    expect(gapAbove("prose", "prose")).toBe(PARAGRAPH_GAP);
  });

  test("Given a voice change inside a turn, When rendered, Then the block gap separates them", () => {
    expect(gapAbove("prose", "tools")).toBe(BLOCK_GAP);
    expect(gapAbove("tools", "prose")).toBe(BLOCK_GAP);
  });

  test("Given every step, When converted to a class, Then it is a literal the scanner can see", () => {
    // The regression this pass shipped and then caught in a screenshot.
    //
    // `spacingClass` originally built `mt-[${gap}px]` by interpolation. Tailwind
    // scans source text statically, so it never saw those four class names, the
    // compiled stylesheet contained no rules for them, and EVERY gap in the
    // transcript rendered as zero. Nothing failed: the components emitted the
    // correct class names and the tests asserted those names, so the only thing
    // missing was the CSS \u2014 which no assertion about strings can detect.
    //
    // This test pins the property that makes the classes findable: each one is
    // spelled out somewhere in the source of `spacing.ts` as a literal. Reading
    // the file is the point; a test that only called the function would agree
    // with an interpolated implementation just as happily as a literal one.
    const source = readFileSync(new URL("../src/timeline/spacing.ts", import.meta.url), "utf8");

    for (const gap of [TURN_GAP, PAIR_GAP, BLOCK_GAP, PARAGRAPH_GAP]) {
      expect(source, `mt-[${gap}px] is not a literal in spacing.ts`).toContain(`"mt-[${gap}px]"`);
    }

    // And the RETIRED literal is gone. Spelling the classes out means a moved
    // step leaves its old class behind in the table — harmless-looking, and
    // exactly how a stale 28px rule stays compiled and one call site keeps
    // spending it.
    expect(source, "the retired 28px turn gap is still spelled in spacing.ts").not.toContain(
      '"mt-[28px]"',
    );
  });

  test("Given every step, When converted, Then the class matches the number", () => {
    // And the literals above are the RIGHT literals. Spelling them out creates a
    // second place the four numbers exist, so this is the check that the table
    // and the constants cannot drift apart.
    const cases: readonly [PartKind | null, PartKind, number][] = [
      ["prose", "user", TURN_GAP],
      ["user", "prose", PAIR_GAP],
      ["prose", "tools", BLOCK_GAP],
      ["prose", "prose", PARAGRAPH_GAP],
    ];

    for (const [previous, part, gap] of cases) {
      expect(spacingClass(previous, part)).toBe(`mt-[${gap}px]`);
    }
  });

  test("Given the first part in the column, When laid out, Then it takes no leading gap", () => {
    // A leading margin at the top of a scroll region is dead space the reader
    // pays for on every session open.
    expect(gapAbove(null, "user")).toBe(0);
  });

  test("Given an epoch, When placed, Then it gets turn air on both sides", () => {
    // A compaction belongs to neither the exchange above it nor the one below,
    // so it must not read as part of either.
    expect(gapAbove("prose", "epoch")).toBe(TURN_GAP);
    expect(gapAbove("epoch", "prose")).toBe(TURN_GAP);
  });
});

/** A run of tool calls with a sentence dropped into the middle of it. */
const INTERLEAVED: readonly TranscriptNode[] = [
  { kind: "prompt", id: "p", text: "go" },
  { kind: "tool", id: "a", tool: "read", target: "one.ts", duration: "1ms" },
  { kind: "tool", id: "b", tool: "read", target: "two.ts", duration: "1ms" },
  {
    kind: "assistant",
    id: "say",
    streaming: false,
    blocks: [{ kind: "p", text: "checking the tests" }],
  },
  { kind: "tool", id: "c", tool: "read", target: "three.ts", duration: "1ms" },
];

describe("tool groups follow chronology", () => {
  test("Given a prose block between calls, When segmented, Then it splits the group", () => {
    // THE chronology rule. Sorting every call to the top of the turn would be
    // tidier and would be a lie about the order the agent thought in.
    const parts = segmentTurns(INTERLEAVED)[0]?.parts ?? [];
    const kinds = parts.map((part) => part.kind);

    expect(kinds).toEqual(["user", "tools", "prose", "tools"]);
  });

  test("Given the split, When the groups are read, Then each holds its own calls", () => {
    const parts = segmentTurns(INTERLEAVED)[0]?.parts ?? [];
    const groups = parts.filter((part) => part.kind === "tools");

    expect(groups).toHaveLength(2);
    expect(groups[0]?.calls.map((call) => call.id)).toEqual(["a", "b"]);
    expect(groups[1]?.calls.map((call) => call.id)).toEqual(["c"]);
  });

  test("Given adjacent calls, When segmented, Then only adjacency groups them", () => {
    // Adjacency in the DATA is the only thing that makes two calls one block,
    // so the split above needs no rule of its own — it falls out of this one.
    const parts = segmentTurns([
      { kind: "tool", id: "a", tool: "read", target: "x", duration: "1ms" },
      { kind: "tool", id: "b", tool: "read", target: "y", duration: "1ms" },
    ])[0]?.parts;

    expect(parts).toHaveLength(1);
  });

  test("Given a session, When segmented, Then a new turn opens on a prompt or an epoch only", () => {
    const turns = segmentTurns([
      { kind: "epoch", id: "e", label: "compacted", at: "11:31" },
      { kind: "prompt", id: "p1", text: "one" },
      { kind: "tool", id: "t", tool: "read", target: "x", duration: "1ms" },
      { kind: "prompt", id: "p2", text: "two" },
    ]);

    expect(turns).toHaveLength(3);
    expect(turns[0]?.parts[0]?.kind).toBe("epoch");
  });
});

const call = (id: string, tool: string, status?: "running" | "waiting" | "failed" | "denied") => ({
  kind: "tool" as const,
  id,
  tool,
  target: `${id}.ts`,
  duration: status === undefined ? "10ms" : undefined,
  ...(status === undefined ? {} : { status }),
});

describe("a tool group folds without hiding a claim", () => {
  test("Given three calls, When laid out, Then the group does not fold", () => {
    // Three rows are still a list the eye takes in whole.
    expect(collapses([call("a", "read"), call("b", "read"), call("c", "read")])).toBe(false);
  });

  test("Given four calls, When laid out, Then the group folds", () => {
    // Four is where a run starts reading as a wall and the summary is the
    // better line.
    expect(COLLAPSE_AFTER).toBe(4);
    expect(
      collapses([call("a", "read"), call("b", "read"), call("c", "read"), call("d", "read")]),
    ).toBe(true);
  });

  test("Given a settled call, When folded, Then it may be hidden", () => {
    // A finished successful call is evidence — it can be asked for.
    expect(isLoud(call("a", "read"))).toBe(false);
  });

  test("Given an unfinished or failed call, When folded, Then it is never hidden", () => {
    // The never-hide rule. A summary saying `6 tools` while one of them is
    // silently waiting for the Owner is the exact failure this prevents.
    for (const status of ["running", "waiting", "failed", "denied"] as const) {
      expect(isLoud(call("x", "shell", status)), status).toBe(true);
    }
  });

  test("Given a folded group, When summarized, Then the loud rows stay pinned", () => {
    const calls = [
      call("a", "read"),
      call("b", "read"),
      call("c", "edit"),
      call("d", "read"),
      call("e", "shell", "running"),
      call("f", "shell", "failed"),
    ];
    const summary = summarize(calls);

    expect(summary.total).toBe(6);
    expect(summary.pinned.map((c) => c.id)).toEqual(["e", "f"]);
  });

  test("Given a summary, When printed, Then it tallies most-frequent first", () => {
    // The line is read as a TALLY — "mostly reads, a couple of edits" — so
    // arrival order would reorder it between renders and make it unscannable.
    const calls = [
      call("a", "read"),
      call("b", "edit"),
      call("c", "read"),
      call("d", "read"),
      call("e", "edit"),
      call("f", "shell"),
    ];

    expect(summaryLabel(summarize(calls), "1.8s")).toBe(
      "6 tools · 3 read · 2 edit · 1 shell · 1.8s",
    );
  });

  test("Given a folded group, When rendered, Then the summary shares the rows' text edge", () => {
    // The alignment defect the Owner reported: the summary line started 12px
    // left of the rows beneath it, because the rows open with a chevron slot and
    // the summary was a bare button with none. `6 tools` and `shell` have to
    // land on ONE x or the block reads as two columns that drifted apart.
    //
    // Asserted as the shared SLOT CLASS rather than as a measured pixel, because
    // the offset is the slot: both lines take the same element, so they cannot
    // disagree without the class differing. A rendered-geometry check would need
    // a browser and would still be testing this same fact one layer down.
    const calls: readonly TranscriptNode[] = [
      call("a", "read"),
      call("b", "read"),
      call("c", "edit"),
      call("d", "shell", "running"),
    ];
    const html = renderToStaticMarkup(<Timeline nodes={calls} sessionId="align" />);

    const slots = [...html.matchAll(/class="([^"]*)"[^>]*data-tool-slot/g)].map((m) => m[1]);
    // One slot on the summary, one on each row still shown.
    expect(slots.length).toBeGreaterThan(1);
    // Every one of them is the SAME class string — that identity IS the shared
    // left edge.
    expect(new Set(slots).size, `slots differ: ${JSON.stringify([...new Set(slots)])}`).toBe(1);

    // And the summary's slot is a real drawn chevron, not an empty reservation:
    // the summary IS the expand toggle, so the slot is occupied rather than held
    // open. An empty slot would align the text and leave the control unmarked.
    const summary = html.indexOf("data-group-summary");
    expect(summary).toBeGreaterThanOrEqual(0);
    const button = html.slice(summary, html.indexOf("</button>", summary));
    expect(button).toContain("data-tool-slot");
    expect(button).toContain("<svg");
  });

  test("Given the tool block, When the indent is traced, Then one constant owns it", () => {
    // SINGLE OWNER. The summary and the rows aligned once by both spelling the
    // same utilities out, and that is exactly how they drifted apart the first
    // time. The slot is declared once in `tool-rows.tsx` and both call sites
    // take it from there, so this reads the source to confirm the literal is
    // written exactly once — a test that only compared rendered output would be
    // just as happy with two copies that currently agree.
    const source = readFileSync(new URL("../src/timeline/tool-rows.tsx", import.meta.url), "utf8");

    expect(source).toContain("const SLOT =");
    expect([...source.matchAll(/const SLOT =/g)]).toHaveLength(1);
    // The width literal appears only in that one declaration.
    expect([...source.matchAll(/w-3 shrink-0/g)]).toHaveLength(1);
  });

  test("Given a group with a live call, When rendered folded, Then that row is on screen", () => {
    // The rendered half of the never-hide rule: the summary is present AND the
    // running row is still drawn under it.
    const calls: readonly TranscriptNode[] = [
      call("a", "read"),
      call("b", "read"),
      call("c", "read"),
      call("d", "read"),
      call("e", "shell", "running"),
    ];
    const html = renderToStaticMarkup(<Timeline nodes={calls} sessionId="fold" />);

    expect(html).toContain("data-group-summary");
    expect(html).toContain('data-tool-row="e"');
    // The settled rows ARE folded away, or the summary would be decoration.
    expect(html).not.toContain('data-tool-row="a"');
  });
});

describe("tool expansion is scoped to its session", () => {
  const held: Expansion = { session: "a", open: new Set(["tool1", "tool2"]) };

  test("Given the same session, When read, Then the open set is kept", () => {
    // Dropping it on every render would close a payload the Owner opened one
    // keystroke ago.
    expect(expansionFor(held, "a")).toBe(held.open);
  });

  test("Given a different session, When read, Then the open set is dropped", () => {
    // The regression. "I opened this call's output" is a fact about reading ONE
    // transcript; carrying it across a switch opens an unrelated row that
    // happens to share an id.
    expect(expansionFor(held, "b").size).toBe(0);
  });

  test("Given a second switch, When read, Then it still resets", () => {
    // This is the case the old implementation failed and the reason the rule is
    // tested as a value. It reset with an effect on an empty dependency list, so
    // it fired once on mount and never again — the FIRST switch looked correct
    // in any rendered snapshot and every switch after it leaked.
    const after: Expansion = { session: "b", open: new Set(["tool9"]) };

    expect(expansionFor(after, "c").size).toBe(0);
    expect(expansionFor(after, "b")).toBe(after.open);
  });

  test("Given a reset, When compared, Then the empty set is identity-stable", () => {
    // The caller detects the reset with an identity check, and every tool group
    // takes this as a prop — a fresh `new Set()` per render would be a new prop
    // for all of them on every keystroke in the composer.
    expect(expansionFor(held, "b")).toBe(expansionFor(held, "c"));
  });
});

/**
 * The whole screen, rendered once, so the accent budget can be counted across
 * it rather than per component.
 */
const SCREEN = renderToStaticMarkup(
  <Console
    composerHint="claude-sonnet-4-6"
    composerMeta="39.8k"
    detail="claude-sonnet-4-6"
    draft=""
    nodes={transcript}
    onApprove={() => undefined}
    onDeny={() => undefined}
    onDraftChange={() => undefined}
    onSubmit={() => undefined}
    pending={pending}
    sessionId="budget"
    sidebar={<nav aria-label="Sessions" />}
    title="ledger append path"
  />,
);

describe("the accent budget", () => {
  test("Given the whole screen, When the accent is counted, Then it is spent only where reserved", () => {
    // The budget, stated as a number. The accent is the system's ONE chroma and
    // it is what makes a live claim findable; every additional site divides that
    // signal, and the division happens one well-argued exception at a time.
    //
    // The four permitted sites: the live/waiting status marks in the transcript,
    // the streaming caret, the focus ring (a utility, not a painted class), and
    // the composer's Approve. `selection:bg-accent` is excluded — it paints only
    // while text is selected, which is the reader's own gesture rather than the
    // surface making a claim.
    const painted = [...SCREEN.matchAll(/(?<![\w:-])(?:bg|text|border)-accent\b/g)].length;
    const selection = [...SCREEN.matchAll(/selection:(?:bg|text)-accent\b/g)].length;

    expect(painted - selection).toBeLessThanOrEqual(4);
  });

  test("Given the screen, When the accent fill is counted, Then only Approve takes one", () => {
    // A fill is the loudest possible use of the chroma, so exactly one control
    // may take it: the one that is blocking work.
    const fills = [...SCREEN.matchAll(/(?<!selection:)bg-accent\b/g)].length;

    expect(fills).toBe(1);
    const at = SCREEN.indexOf("bg-accent");
    expect(SCREEN.slice(at - 200, at + 200)).toContain("data-approve");
  });

  test("Given a blocked row, When rendered, Then it reports without taking the accent", () => {
    // The accent points at the thing that can be ACTED on, and that is the
    // tray's Approve, not the row. Colouring both splits the one chroma across
    // two places and aims the louder of them at the element with no control on
    // it. `running` keeps the accent because it is a claim about right now.
    const html = renderToStaticMarkup(<Timeline nodes={transcript} sessionId="wait" />);
    const at = html.indexOf("waiting for approval");
    expect(at).toBeGreaterThanOrEqual(0);

    const row = html.slice(html.lastIndexOf("<span", at), at);
    expect(row).not.toContain("text-accent");
  });

  test("Given a pending approval, When rendered, Then the transcript row offers no decision", () => {
    // One place to approve a call, and it is the one that does not scroll away.
    // The row reports that a decision is outstanding; the tray carries it.
    const html = renderToStaticMarkup(<Timeline nodes={transcript} sessionId="wait" />);

    expect(html).toContain("waiting for approval");
    expect(html).not.toContain("data-approve");
    expect(html).not.toContain("data-deny");
  });

  test("Given the tray, When rendered, Then it sits above the composer in the same column", () => {
    const tray = SCREEN.indexOf("data-approval-tray");
    const composer = SCREEN.indexOf("data-composer");

    expect(tray).toBeGreaterThanOrEqual(0);
    expect(composer).toBeGreaterThan(tray);
  });

  test("Given the tray, When rendered, Then the keyboard path is printed", () => {
    // A decision the Owner will make hundreds of times must not require the
    // mouse the second time.
    expect(SCREEN).toContain("⌘↩");
    expect(SCREEN).toContain("⌘⌫");
  });
});

/**
 * The transcript opens on its newest turn.
 *
 * The scroll POSITION itself cannot be asserted here: these tests render to
 * static markup, which has no viewport, no scroll offset and no composer to be
 * hidden behind, so the defect this guards (the last turn sitting below the
 * fold) is invisible to every assertion in this file.
 *
 * What IS assertable here is the WIRING — that the console asks for end-pinning
 * at all, and that the navigator does not. Dropping the prop is a one-character
 * edit that this catches in the normal suite.
 */
describe("the transcript opens on its newest turn", () => {
  test("Given the console, When composed, Then the transcript column pins to the end", () => {
    const source = readFileSync(new URL("../src/console.tsx", import.meta.url), "utf8");
    const scroll = source.indexOf("<ScrollArea");

    expect(scroll).toBeGreaterThanOrEqual(0);
    expect(source.slice(scroll, source.indexOf(">", scroll))).toContain("pinToEnd");
  });

  test("Given the primitive, When pinning is off, Then it never touches scrollTop", () => {
    // Opt-in, and the default is off. A primitive that pinned by default would
    // scroll the session tree away from its top-ranked row every time a status
    // changed — the navigator's newest material is wherever the ranking put it,
    // not at the bottom.
    const source = readFileSync(
      new URL("../src/primitives/scroll-area.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("pinToEnd !== true");
    // The early return precedes every listener and observer it installs.
    const guard = source.indexOf("pinToEnd !== true");
    expect(source.indexOf("addEventListener")).toBeGreaterThan(guard);
    expect(source.indexOf("ResizeObserver")).toBeGreaterThan(guard);
  });
});

/**
 * The diff exception, and its fence.
 *
 * `--color-diff-add` / `--color-diff-remove` are the system's ONE scoped
 * exception to the single-accent law, admitted because green-is-added /
 * red-is-removed is the universal diff convention rather than a decoration this
 * system chose. An exception with no boundary is just a palette arriving
 * slowly, so the boundary is asserted here: the two tokens may be spent inside a
 * code block's diff rows and nowhere else on the screen.
 */
describe("the diff exception stays scoped to diff rows", () => {
  test("Given a diff line, When rendered, Then the marker and the sign carry the hue", () => {
    // The exception has to be REAL, or the scoping test below passes vacuously
    // on a surface that simply never uses the tokens.
    const at = SCREEN.indexOf('data-mark-bar="add"');
    expect(at).toBeGreaterThanOrEqual(0);

    const bar = SCREEN.slice(SCREEN.lastIndexOf("<span", at), at);
    expect(bar).toContain("bg-diff-add");

    const sign = SCREEN.indexOf('data-mark-char="remove"');
    expect(sign).toBeGreaterThanOrEqual(0);
    expect(SCREEN.slice(SCREEN.lastIndexOf("<span", sign), sign)).toContain("text-diff-remove");
  });

  test("Given the whole screen, When diff tokens are counted, Then each sits on a diff row", () => {
    // THE scoping gate. Every `diff-*` utility on the screen must belong to an
    // element that also carries a diff-row attribute — the row itself
    // (`data-mark`), its marker bar, or its sign. A `text-diff-add` on a status
    // word, a button, or a prose run has none of those and trips immediately.
    const uses = [...SCREEN.matchAll(/<[^>]*?(?:bg|text|border)-diff-(?:add|remove)[^>]*>/g)].map(
      ([tag]) => tag,
    );

    expect(uses.length, "diff tokens exist to scope").toBeGreaterThan(0);
    for (const tag of uses) {
      expect(tag, `a diff token is spent outside a diff row: ${tag}`).toMatch(/\sdata-mark[-=]/);
    }

    // Anti-vacuity: the pattern must actually reject a token spent elsewhere,
    // or the loop above passes on any markup at all.
    expect('<span class="text-diff-add">running</span>').not.toMatch(/\sdata-mark[-=]/);
  });

  test("Given the source tree, When diff tokens are traced, Then only the gutter names them", () => {
    // The other half, read from source rather than markup: a token used on a
    // surface the fixture happens not to render would never appear in SCREEN.
    // The gutter is the one primitive that draws a diff, so it is the one file
    // allowed to name the tokens — anything else naming them is the exception
    // generalising into the state palette this system deleted.
    const root = new URL("../src/", import.meta.url);
    const offenders: string[] = [];

    for (const relative of [
      "primitives/code.tsx",
      "primitives/row.tsx",
      "primitives/state.tsx",
      "primitives/surface.tsx",
      "primitives/button.tsx",
      "timeline/tool-rows.tsx",
      "timeline/timeline.tsx",
      "timeline/markdown-block.tsx",
      "timeline/voice.tsx",
      "composer.tsx",
      "console.tsx",
      "chrome.tsx",
    ]) {
      const source = readFileSync(new URL(relative, root), "utf8");
      if (/(?:bg|text|border)-diff-(?:add|remove)/.test(source)) offenders.push(relative);
    }

    expect(offenders).toEqual([]);

    // ...and the gutter genuinely does, so the list above is not passing because
    // the pattern is wrong.
    const gutter = readFileSync(new URL("primitives/gutter.tsx", root), "utf8");
    expect(gutter).toMatch(/bg-diff-add/);
    expect(gutter).toMatch(/text-diff-remove/);
  });

  test("Given a diff row, When tinted, Then the row wash stays under 6% and the code stays achromatic", () => {
    // The tint LOCATES the row; it never carries the claim. Past a faint wash it
    // becomes the loudest region on a text-first surface, and the meaning would
    // be re-encoded in the one channel a colorblind reader cannot use.
    const gutter = readFileSync(new URL("../src/primitives/gutter.tsx", import.meta.url), "utf8");

    for (const [, alpha] of gutter.matchAll(/bg-diff-(?:add|remove)\/(\d+)/g)) {
      expect(Number(alpha), `row tint ${alpha}% exceeds the 6% ceiling`).toBeLessThanOrEqual(6);
    }

    // The code text keeps the achromatic syntax ramp: the tokens are spent on
    // the bar and the sign only.
    const code = readFileSync(new URL("../src/primitives/code.tsx", import.meta.url), "utf8");
    expect(code).not.toMatch(/diff-(?:add|remove)/);
  });
});

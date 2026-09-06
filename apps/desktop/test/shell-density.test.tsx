import { describe, expect, test } from "bun:test";
import { Timeline } from "@openomni/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/renderer/app";
import { timelines } from "../src/renderer/mock/timelines";

/**
 * The renderer reads at Shell density, and every transcript role declares its
 * type level.
 *
 * This is the regression test for the defect the owner reported: the shell
 * rendered its transcript in the sans prose ramp two steps too large, and every
 * other gate stayed green. Two independent causes produced it, so both are
 * pinned separately here.
 *
 *   1. The window root did not carry `data-density="shell"`, so the whole
 *      surface fell back to the System scale.
 *   2. Row content that declared a tone but no LEVEL inherited the document's
 *      16px default, which no token in the system names.
 *
 * `packages/ui/test/density.test.ts` pins what the shell tokens ARE. This file
 * pins that this surface is actually inside them.
 */

const SHELL = renderToStaticMarkup(<App />);

function transcript(id: string): string {
  const nodes = timelines[id];
  if (!nodes) throw new Error(`no timeline fixture for ${id}`);
  return renderToStaticMarkup(<Timeline emptyLabel="empty" nodes={nodes} sessionId={id} />);
}

/**
 * The three voices, as the exact class pairs the transcript emits.
 *
 * They are spelled out here rather than imported so this gate is INDEPENDENT of
 * the module it checks: importing `voiceClass` would make the test agree with
 * whatever the source says, including a fourth voice someone added.
 */
const PROSE = "text-[14px]/[21px]";
const CODE = "text-[13px]/[20px]";
const META = "text-[12px]/[18px]";
const VOICES = ["14/21", "13/20", "12/18"];

describe("the shell renders at shell density", () => {
  test("Given the window root, When rendered, Then it declares the shell density scope", () => {
    // The attribute is on the ROOT because the whole window is the shell: the
    // navigator and the transcript are one surface at one density. Scoping it
    // lower leaves whichever column was missed on the System scale, which is
    // exactly how this regressed.
    expect(SHELL).toContain('data-density="shell"');
  });

  test("Given the window, When the scope is counted, Then exactly one element declares it", () => {
    // Nested density scopes are how a surface acquires two type scales. One
    // declaration, at the top, or the cascade decides per subtree.
    expect(SHELL.match(/data-density="shell"/g)).toHaveLength(1);
  });

  test("Given the density scope, When placed, Then it wraps both columns", () => {
    // The navigator must be INSIDE the scope, not a sibling of it: the reported
    // defect was visible in the sidebar first, because its rows are the densest
    // thing on screen.
    const at = SHELL.indexOf('data-density="shell"');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(SHELL.indexOf('aria-label="Sessions"')).toBeGreaterThan(at);
    expect(SHELL.indexOf("<main")).toBeGreaterThan(at);
  });
});

describe("the transcript sets exactly three voices", () => {
  const IDS = Object.keys(timelines);

  test("Given the fixtures, When surveyed, Then there is something to assert", () => {
    expect(IDS.length).toBeGreaterThan(0);
  });

  test("Given each transcript, When rendered, Then every size is one of the three voices", () => {
    // THE gate on the transcript law. Three voices and no fourth: any
    // `text-[Npx]` in the column that is not one of these three is a size the
    // reader has to learn, and at five sizes a system stops reading as a system.
    //
    // Code-fence INTERIORS are exempt because the `<pre>` owns one size for the
    // whole block and its syntax tokens carry tone only — the fence is asserted
    // as a unit separately.
    for (const id of IDS) {
      const html = transcript(id);
      const outside = html
        .split(/<pre[\s\S]*?<\/pre>/)
        .join("");
      const sizes = [...outside.matchAll(/text-\[(\d+)px\]\/\[(\d+)px\]/g)].map(
        (m) => `${m[1]}/${m[2]}`,
      );
      expect(sizes.length, `no sized text in ${id}`).toBeGreaterThan(0);
      for (const size of sizes) {
        expect(VOICES, `unnamed size ${size} in ${id}`).toContain(size);
      }
    }
  });

  test("Given the transcript markup, When scanned, Then no scale class leaks into it", () => {
    // The other half of the gate. The three voices are literal pixel pairs, so
    // a `text-body` or `text-meta` from the shared type scale appearing in the
    // column means something is being sized by the density scope instead — a
    // fourth voice that arrives without anyone declaring one.
    for (const id of IDS) {
      const outside = transcript(id)
        .split(/<pre[\s\S]*?<\/pre>/)
        .join("");
      for (const level of ["text-display", "text-title", "text-heading", "text-body", "text-label"]) {
        expect(outside, `${level} leaked into the transcript in ${id}`).not.toContain(level);
      }
    }
  });

  test("Given a code fence, When rendered, Then the block owns one size for all its tokens", () => {
    // The fence is the one place a size is set on a container rather than per
    // node, and that is deliberate: code is a block of uniform text, and a
    // fence whose tokens each carried their own size would ripple.
    const withCode = IDS.find((id) =>
      (timelines[id] ?? []).some(
        (node) => node.kind === "assistant" && node.blocks.some((b) => b.kind === "code"),
      ),
    );
    if (!withCode) throw new Error("no code fixture");

    const html = transcript(withCode);
    const pre = html.slice(html.indexOf("<pre"), html.indexOf("</pre>"));
    expect(pre).toContain("font-mono");
    // And the size it owns is the CODE voice specifically — without this the
    // test would pass on a fence set in any monospace size at all, which is the
    // fourth voice arriving in the one element allowed to set its own.
    expect(pre).toContain(CODE);
  });

  test("Given a tool call, When rendered, Then it is ONE line in the meta voice", () => {
    // A tool call is one line: `read  src/auth.ts · 34ms`. No row height, no
    // two-line layout, no status column — those belonged to the grammar this
    // replaced, and the row is the transcript's densest element becoming its
    // most decorated one the moment any of them come back.
    const withTool = IDS.find((id) => (timelines[id] ?? []).some((node) => node.kind === "tool"));
    if (!withTool) throw new Error("no tool fixture");

    const html = transcript(withTool);
    const row = html.slice(html.indexOf("data-tool-row"));
    expect(row).toContain(META);
    expect(html).not.toContain('lines="two"');
    expect(html).not.toContain("h-row");
  });

  test("Given the transcript, When prose is rendered, Then it is the prose voice", () => {
    const withPrompt = IDS.find((id) =>
      (timelines[id] ?? []).some((node) => node.kind === "prompt"),
    );
    if (!withPrompt) throw new Error("no prompt fixture");

    expect(transcript(withPrompt)).toContain(PROSE);
  });

  test("Given a user message, When rendered, Then it is a right-aligned block with no fill", () => {
    // The one asymmetry that tells two speakers apart. It must stay geometry:
    // a background or a border here is the chat bubble the column rejected.
    const withPrompt = IDS.find((id) =>
      (timelines[id] ?? []).some((node) => node.kind === "prompt"),
    );
    if (!withPrompt) throw new Error("no prompt fixture");

    const html = transcript(withPrompt);
    const marker = html.indexOf("data-user-message");
    expect(marker).toBeGreaterThanOrEqual(0);
    // From the wrapper's own `<div` — the alignment class sits before the
    // marker attribute — up to the message's text, which is where the block's
    // classes end. A fixed-width window would silently stop asserting the
    // moment a fixture's prompt got longer.
    const block = html.slice(html.lastIndexOf("<div", marker), html.indexOf("</p>", marker));
    expect(block).toContain("justify-end");
    expect(block).toContain("max-w-[82%]");
    // Left-aligned TEXT inside a right-aligned block: right-set prose is
    // decoration, and this is something a person wrote.
    expect(block).toContain("text-left");
    expect(block).not.toMatch(/bg-(raised|sunken|accent|hover)/);
    expect(block).not.toMatch(/\bborder\b/);
  });
});

describe("the sidebar row keeps its own rank", () => {
  test("Given a session row, When rendered, Then the name is label and the reason is meta", () => {
    // The row is two lines and the second must read as supporting the first.
    // Both levels have to be NAMED: the name used to inherit 16px, which put a
    // session name above the transcript's own prose.
    expect(SHELL).toContain("text-label");
    expect(SHELL).toContain("text-meta");
  });

  test("Given the navigator, When scanned, Then no element sets a raw font size", () => {
    // Sizes in the SIDEBAR come from the shared scale or they are drift: an
    // arbitrary-value size class is how a single row escapes the density scope.
    //
    // The transcript is the deliberate exception and is excluded here rather
    // than exempted silently. Its three voices are literal pixel pairs BECAUSE
    // they must not be re-pointable by a density scope, and that rule is gated
    // above. Two different laws, so two different assertions.
    const nav = SHELL.slice(
      SHELL.indexOf('aria-label="Sessions"'),
      SHELL.indexOf("<main"),
    );
    expect(nav.length).toBeGreaterThan(0);
    expect(nav).not.toMatch(/text-\[\d+(px|rem)\]/);
    expect(nav).not.toMatch(/font-size:/);
  });
});

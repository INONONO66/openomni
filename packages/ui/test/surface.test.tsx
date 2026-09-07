import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Highlight } from "../src/primitives/highlight";
import { ScrollArea } from "../src/primitives/scroll-area";
import { Panel, Text } from "../src/primitives/surface";

/** The surface layer: tone, structure, and typography, with no interaction. */
describe("Panel", () => {
  test("Given an edge, When rendered, Then only left and right splits exist", () => {
    expect(renderToStaticMarkup(<Panel edge="right">x</Panel>)).toContain("border-r");
    expect(renderToStaticMarkup(<Panel edge="left">x</Panel>)).toContain("border-l");
    expect(renderToStaticMarkup(<Panel>x</Panel>)).not.toContain("border");
  });

  test("Given each tone, When rendered, Then the tonal ramp is three steps", () => {
    expect(renderToStaticMarkup(<Panel tone="bg">x</Panel>)).toContain("bg-bg");
    expect(renderToStaticMarkup(<Panel tone="sunken">x</Panel>)).toContain("bg-sunken");
    expect(renderToStaticMarkup(<Panel tone="raised">x</Panel>)).toContain("bg-raised");
  });
});

describe("Text", () => {
  test("Given the announce levels, When rendered, Then weight never reaches 700", () => {
    // 590 is the ceiling: past it Pretendard stops adding hierarchy.
    for (const level of ["display", "title", "heading"] as const) {
      const html = renderToStaticMarkup(<Text level={level}>x</Text>);

      expect(html).not.toContain("font-bold");
      expect(html).not.toContain("font-[700]");
    }
  });

  test("Given numeric text, When rendered, Then tabular figures are requested", () => {
    expect(renderToStaticMarkup(<Text numeric>1487</Text>)).toContain("tabular-nums");
  });

  test("Given mono text, When rendered, Then the machine-truth family is used", () => {
    expect(renderToStaticMarkup(<Text mono>fs.read</Text>)).toContain("font-mono");
  });
});

describe("Highlight", () => {
  const runs = [
    { text: "led", matched: true },
    { text: "ger append path", matched: false },
  ] as const;

  test("Given matched runs, When rendered, Then emphasis is weight and tone, never a fill", () => {
    // The system's one chroma is spent on live state and the primary action, so
    // a match cannot buy a color — and a highlight FILL would put a second box
    // inside a row whose whole hierarchy is quiet type on whitespace.
    const html = renderToStaticMarkup(<Highlight runs={runs} />);

    expect(html).toContain("font-medium");
    expect(html).toContain("text-fg");
    expect(html).not.toContain("bg-");
    expect(html).not.toContain("accent");
    expect(html).not.toContain("underline");
  });

  test("Given a rest tone, When rendered, Then only the unmatched remainder takes it", () => {
    // The matched run is always primary; the rest keeps the tone the row would
    // have had, so a selected row does not lose its weight signal to the match.
    const muted = renderToStaticMarkup(<Highlight runs={runs} tone="muted" />);

    expect(muted).toContain("text-fg-muted");
    expect(muted).toContain('class="font-medium text-fg"');
  });

  test("Given every run, When rendered, Then the full label survives in order", () => {
    // A highlight that drops or reorders glyphs is a renamed row.
    const html = renderToStaticMarkup(<Highlight runs={runs} />);
    const text = html
      .split("<")
      .map((chunk) => chunk.slice(chunk.indexOf(">") + 1))
      .join("");

    expect(text).toBe("ledger append path");
  });

  test("Given no match, When rendered, Then nothing is emphasised", () => {
    const html = renderToStaticMarkup(
      <Highlight runs={[{ text: "ledger append path", matched: false }]} />,
    );

    expect(html).not.toContain("font-medium");
  });
});

describe("ScrollArea", () => {
  test("Given content, When rendered, Then the viewport is the single scrolling element", () => {
    const html = renderToStaticMarkup(
      <ScrollArea className="probe-root" contentClassName="probe-content">
        rows
      </ScrollArea>,
    );

    expect(html).toContain("probe-root");
    expect(html).toContain("probe-content");
    expect(html).toContain("overflow:scroll");
    expect(html).toContain("overscroll-contain");
    expect(html).toContain(">rows<");
  });
});

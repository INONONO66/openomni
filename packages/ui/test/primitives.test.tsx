import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IconButton } from "../src/primitives/button";
import { CodeFence, CodeToken } from "../src/primitives/code";

/**
 * Primitives are asserted through their rendered markup: the class map a
 * variant/tone selects, and the semantics Base UI contributes.
 */

describe("IconButton", () => {
  test("xs reserves a 20px box and a 12px glyph", () => {
    const html = renderToStaticMarkup(<IconButton label="Close" size="xs"><svg aria-hidden="true" /></IconButton>);
    expect(html).toContain("size-control-xs");
    expect(html).toContain("]:size-3");
  });
  test("Given a label, When rendered, Then it names itself and stays square", () => {
    const html = renderToStaticMarkup(
      <IconButton label="New session" size="sm">
        <svg aria-hidden="true" />
      </IconButton>,
    );

    expect(html).toContain('aria-label="New session"');
    expect(html).toContain("size-control-sm");
  });

  test("Given no variant, When rendered, Then it is ghost with the shared state set", () => {
    const html = renderToStaticMarkup(
      <IconButton label="Close">
        <svg aria-hidden="true" />
      </IconButton>,
    );

    expect(html).not.toContain("bg-accent");
    expect(html).toContain("hover:bg-hover");
    expect(html).toContain("active:");
    expect(html).toContain("focus-ring");
  });
});

describe("CodeFence", () => {
  test("Given a fence, When rendered, Then a hairline edge lets the fill stay faint", () => {
    // The fill and the edge are ONE decision. Without a border the fill was the
    // only thing defining the region, so it had to be strong enough to read
    // unaided — which is a grey box. One pixel of `line-surface` lets the fill
    // drop to `sunken`, the lightest step off the column (~1.05:1 from `bg`):
    // barely a tint, yet unmistakably a region, because the edge now does the
    // defining the fill used to strain at.
    const html = renderToStaticMarkup(<CodeFence lang="rust">let x = 1;</CodeFence>);

    expect(html).toContain("bg-sunken");
    expect(html).toContain("border-line-surface");
    expect(html).not.toContain("bg-raised");
  });

  test("Given a fence, When rendered, Then its edge is a hairline on the surface radius", () => {
    // A fence is a bigger rectangle than a row but the same KIND of thing, so
    // it takes the shared surface radius rather than a bespoke corner — two
    // answers to "how round is a surface here" would read as inconsistency
    // long before it read as hierarchy.
    const html = renderToStaticMarkup(<CodeFence lang="rust">let x = 1;</CodeFence>);

    expect(html).toContain("rounded-md");
    expect(html).not.toMatch(/border-[lrtbxy]?-?[2-9]\b/);
  });
});

describe("CodeToken", () => {
  test("Given every tone, When rendered, Then none of them spends chroma", () => {
    // The accent is reserved for live state, so a fence reads by tone and
    // weight alone and never becomes the loudest region on the surface.
    for (const tone of [
      "plain",
      "keyword",
      "string",
      "number",
      "comment",
      "fn",
      "punct",
    ] as const) {
      expect(renderToStaticMarkup(<CodeToken tone={tone}>x</CodeToken>)).not.toContain("accent");
    }
  });

  test("Given distinct tones, When rendered, Then they are still distinguishable", () => {
    const keyword = renderToStaticMarkup(<CodeToken tone="keyword">let</CodeToken>);
    const comment = renderToStaticMarkup(<CodeToken tone="comment">rem</CodeToken>);

    expect(keyword).not.toBe(comment);
  });
});

import { describe, expect, test } from "bun:test";
import { IconButton } from "../src/primitives/button";
import { CodeFence, CodeToken } from "../src/primitives/code";
import { attributes, classes } from "./markup";

describe("IconButton", () => {
  test("xs reserves a 20px box and a 12px glyph", () => {
    const tokens = classes(
      <IconButton label="Close" size="xs">
        <svg aria-hidden="true" />
      </IconButton>,
      "button",
    );
    expect(tokens).toContain("size-control-xs");
    expect(tokens).toContain("[&_svg:not([class*='size-'])]:size-3");
  });
  test("Given a label, When rendered, Then it names itself and stays square", () => {
    const button = (
      <IconButton label="New session" size="sm">
        <svg aria-hidden="true" />
      </IconButton>
    );
    expect(attributes(button, "button")[0]?.["aria-label"]).toBe("New session");
    expect(classes(button, "button")).toContain("size-control-sm");
  });
  test("Given no variant, When rendered, Then it is ghost with the shared state set", () => {
    const tokens = classes(
      <IconButton label="Close">
        <svg aria-hidden="true" />
      </IconButton>,
      "button",
    );
    expect(tokens).not.toContain("bg-accent");
    expect(tokens).toContain("hover:bg-hover");
    expect(tokens).toContain("active:bg-active");
    expect(tokens).toContain("focus-ring");
  });
});

describe("CodeFence", () => {
  test("Given a fence, When rendered, Then a hairline edge lets the fill stay faint", () => {
    const tokens = classes(<CodeFence lang="rust">let x = 1;</CodeFence>);
    expect(tokens).toContain("bg-sunken");
    expect(tokens).toContain("border-line-surface");
    expect(tokens).not.toContain("bg-raised");
  });
  test("Given a fence, When rendered, Then its edge is a hairline on the surface radius", () => {
    const tokens = classes(<CodeFence lang="rust">let x = 1;</CodeFence>);
    expect(tokens).toContain("rounded-md");
    expect(tokens.filter((token) => /^border-[lrtbxy]?-?[2-9]$/.test(token))).toEqual([]);
  });
});

describe("CodeToken", () => {
  test("Given every tone, When rendered, Then none of them spends chroma", () => {
    for (const tone of [
      "plain",
      "keyword",
      "string",
      "number",
      "comment",
      "fn",
      "punct",
    ] as const) {
      expect(
        classes(<CodeToken tone={tone}>x</CodeToken>).filter((token) => token.includes("accent")),
      ).toEqual([]);
    }
  });
  test("Given distinct tones, When rendered, Then they are still distinguishable", () => {
    expect(classes(<CodeToken tone="keyword">x</CodeToken>)).not.toEqual(
      classes(<CodeToken tone="comment">x</CodeToken>),
    );
  });
});

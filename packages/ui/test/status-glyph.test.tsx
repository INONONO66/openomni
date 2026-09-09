import { expect, test } from "bun:test";
import { Glob } from "bun";
import { attributes, classes } from "./markup";
import { StatusGlyph } from "../src/status-glyph";

test("glyph tones resolve only to their designated tokens", () => {
  for (const tone of [
    "progress",
    "attention",
    "success",
    "destructive",
    "muted",
    "faint",
  ] as const) {
    const [glyph] = attributes(<StatusGlyph tone={tone} shape="ring" />, '[data-ui="StatusGlyph"]');
    expect(glyph?.style).toBe(
      `color:var(--${tone === "muted" || tone === "faint" ? "color-fg" : "status"}-${tone})`,
    );
  }
});

test("every shape is an SVG with a crisp stroke", () => {
  for (const shape of [
    "spinner",
    "ring",
    "dot-pulse",
    "check",
    "cross",
    "pause",
    "hollow",
  ] as const) {
    const glyphs = attributes(<StatusGlyph tone="muted" shape={shape} />, "svg");
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]?.["data-shape"]).toBe(shape);
    expect(glyphs[0]?.["stroke-width"]).toBe("1.5");
  }
});

test("glyph sizes are named and bounded", () => {
  for (const [size, box] of [
    ["regular", "size-4"],
    ["compact", "size-3.5"],
  ] as const) {
    const glyph = <StatusGlyph shape="hollow" tone="muted" size={size} />;
    expect(attributes(glyph, "svg")[0]?.["data-size"]).toBe(size);
    expect(classes(glyph, "svg")).toContain(box);
  }
});

test("animated shapes have status keyframes and reduced-motion fallbacks", async () => {
  const source = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  expect(source).toContain("@keyframes status-spin");
  expect(source).toContain("@keyframes status-pulse");
  expect(source).toContain("@keyframes status-entrance");
  expect(source).toContain("@media (prefers-reduced-motion: reduce)");
  expect(source).toContain(".status-spinner");
  expect(source).toContain(".status-dot-pulse");
  expect(source).toContain(".status-entrance");
  expect(source).toContain("transform: scale(1.25)");
  expect(source).toMatch(/\.status-glyph\[data-shape="hollow"\]\s*\{\s*opacity: 0\.45;/);
  expect(source).toMatch(/:hover \.status-glyph\s*\{\s*opacity: 1 !important;/);
  for (const [shape, animation] of [
    ["spinner", "status-spinner"],
    ["dot-pulse", "status-dot-pulse"],
    ["check", "status-entrance"],
    ["cross", "status-entrance"],
  ] as const) {
    expect(classes(<StatusGlyph shape={shape} tone="muted" />, "svg")).toContain(animation);
  }
});

test("status tokens may be declared in styles but consumed only by StatusGlyph", async () => {
  const violations: string[] = [];
  for (const root of ["../src", "../../../apps/desktop/src"]) {
    const cwd = new URL(root, import.meta.url).pathname;
    for await (const path of new Glob("**/*.{ts,tsx,css}").scan({ cwd })) {
      const source = await Bun.file(`${cwd}/${path}`).text();
      const uses =
        root === "../src" && path === "styles.css"
          ? source.replace(/^\s*--status-[\w-]+:\s*[^;]+;/gm, "")
          : source;
      if (!(root === "../src" && path === "status-glyph.tsx") && uses.includes("--status-"))
        violations.push(`${root}/${path}`);
    }
  }
  expect(violations).toEqual([]);
});

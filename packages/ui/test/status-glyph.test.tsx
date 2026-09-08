import { expect, test } from "bun:test";
import { Glob } from "bun";
import { renderToStaticMarkup } from "react-dom/server";
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
    const html = renderToStaticMarkup(<StatusGlyph tone={tone} shape="ring" />);
    expect(html).toContain(
      `color:var(--${tone === "muted" || tone === "faint" ? "color-fg" : "status"}-${tone})`,
    );
    expect(html).toContain('data-ui="StatusGlyph"');
  }
});

test("every shape is an SVG with a crisp one-pixel stroke", () => {
  for (const shape of [
    "spinner",
    "ring",
    "dot-pulse",
    "check",
    "cross",
    "pause",
    "hollow",
  ] as const) {
    const html = renderToStaticMarkup(<StatusGlyph tone="muted" shape={shape} />);
    expect(html).toContain(`data-shape="${shape}"`);
    expect(html).toContain('stroke-width="1"');
    expect(html).toContain("<svg");
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

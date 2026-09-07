import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The strip's geometry is a handful of tokens that must add up: the collapsed
 * zone and the overlay panel share one width token, which must hold the zone's
 * inset, the control step, and the gaps; the numbers behind it are the
 * reference console's. Asserted on
 * the CSS text, because a token that drifts is invisible to the compiler.
 */
const SRC = join(import.meta.dir, "..", "src");
const CSS = await Bun.file(join(SRC, "styles.css")).text();

/** A `--token: <n>px` declaration, in px. */
function px(token: string): number {
  const hit = CSS.match(new RegExp(`${token}:\\s*(\\d+(?:\\.\\d+)?)px;`));
  if (!hit) throw new Error(`${token} is not a px literal`);
  return Number(hit[1]);
}

/** A `--token: calc(...)` declaration, as its expression text with whitespace folded. */
function calc(token: string): string {
  const hit = CSS.match(new RegExp(`${token}:\\s*calc\\(([^;]+)\\);`))?.[1];
  if (hit === undefined) throw new Error(`${token} is not a calc()`);
  return hit.replace(/\s+/g, " ").trim();
}

describe("the strip's tokens", () => {
  test("Given the reference measurements, When read, Then strip 42, tab 26, control 28, safe zone 81", () => {
    expect(px("--spacing-shell-strip")).toBe(42);
    expect(px("--spacing-tab-height")).toBe(26);
    expect(px("--spacing-control-base")).toBe(28);
    expect(px("--spacing-traffic-safe")).toBe(81);
    expect(CSS).toContain("--shell-top: var(--spacing-shell-strip);");
  });

  test("Given the darwin inset, When resolved, Then the toggle starts at 89 = safe zone + 8", () => {
    expect(calc("--spacing-strip-inset-darwin")).toBe("var(--spacing-traffic-safe) + 8px");
    expect(px("--spacing-traffic-safe") + 8).toBe(89);
  });

  test("Given the collapsed zone and the overlay, When resolved, Then both read ONE token that holds the zone's contents", () => {
    const overlay = px("--spacing-sidebar-overlay");
    const control = px("--spacing-control-base");
    const inset = px("--spacing-traffic-safe") + 8;
    // darwin: 89 inset + toggle + gap + trio (3 controls, 2 gaps) + 12 right pad.
    const contents = inset + control + 4 + (3 * control + 2 * 4) + 12;
    expect(contents).toBe(225);
    expect(overlay).toBeGreaterThanOrEqual(contents);
    expect(overlay).toBe(240);
  });

  test("Given the trio's fade, When read, Then it is a progress property on the zone's own duration and curve, driven by data-collapsed", () => {
    expect(CSS).toContain('@property --strip-trio-progress {\n  syntax: "<number>";');
    const utility = CSS.slice(CSS.indexOf("@utility strip-trio {"));
    const block = utility.slice(0, utility.indexOf("\n}\n"));
    expect(block).toContain("transition-property: --strip-trio-progress;");
    expect(block).toContain("transition-duration: var(--duration-base);");
    expect(block).toContain("transition-timing-function: var(--ease-frame);");
    expect(block).toContain('&[data-collapsed="true"] {\n    --strip-trio-progress: 1;');
    // The reference's clamp(1 - 3p, 0, 1), p from the nearer end.
    expect(block.replace(/\s+/g, " ")).toContain(
      "opacity: clamp( 0, 1 - 3 * min(var(--strip-trio-progress), 1 - var(--strip-trio-progress)), 1 );",
    );
    expect(CSS).not.toContain("@starting-style");
  });

  test("Given the strip's source, When read, Then the trio carries no key: one node in both states", async () => {
    const strip = await Bun.file(join(SRC, "tab-strip.tsx")).text();
    const trio = strip.slice(strip.indexOf('className="strip-trio'), strip.indexOf("<HistoryMenu"));
    expect(trio).toContain("data-collapsed={!open}");
    expect(trio).not.toContain("key=");
    expect(strip).not.toContain("key={open");
  });
});

describe("the strip's glyphs", () => {
  test("Given the reference's 16px icons at 1.5 units, When read, Then the stroked glyphs run 1.5px in screen pixels at the 16px sites only", async () => {
    expect(px("--stroke-glyph")).toBe(1.5);
    const utility = CSS.slice(CSS.indexOf("@utility glyph-stroke {"));
    const block = utility.slice(0, utility.indexOf("\n}\n"));
    expect(block).toContain("stroke-width: var(--stroke-glyph);");
    expect(block).toContain("vector-effect: non-scaling-stroke;");
    const button = await Bun.file(join(SRC, "primitives", "button.tsx")).text();
    const sizes = Object.fromEntries(
      [...button.matchAll(/^\s+(sm|base|md): "([^"]+)",$/gm)].map((hit) => [hit[1], hit[2]]),
    );
    expect(sizes.base).toContain("[&_svg]:glyph-stroke");
    expect(sizes.sm).not.toContain("glyph-stroke");
    expect(sizes.md).not.toContain("glyph-stroke");
    const nav = await Bun.file(join(SRC, "sidebar-nav.tsx")).text();
    expect(nav).toContain("[&_svg]:glyph-stroke flex h-7");
  });

  test("Given the strip, When its imports are read, Then the toggle and chevrons are ours, not lucide's", async () => {
    const strip = await Bun.file(join(SRC, "tab-strip.tsx")).text();
    const lucide = strip.match(/import \{([^}]+)\} from "lucide-react"/)?.[1] ?? "";
    expect(lucide.split(",").map((name) => name.trim())).toEqual(["Plus"]);
    expect(strip).toContain('from "./icons/sidebar-toggle"');
    expect(strip).toContain('from "./icons/chevron"');
  });
});

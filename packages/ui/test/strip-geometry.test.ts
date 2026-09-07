import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The strip's geometry is a handful of tokens that must add up: the collapsed
 * zone's width is stated as a `calc()` over the inset, the control step, and
 * the gaps, and the numbers behind it are the reference console's. Asserted on
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

  test("Given the collapsed zone, When resolved, Then its width is the sum of its tokens: 225 on darwin, 140 elsewhere", () => {
    const control = px("--spacing-control-base");
    const inset = px("--spacing-traffic-safe") + 8;
    expect(calc("--spacing-tab-controls-collapsed")).toBe(
      "var(--spacing-strip-inset-darwin) + 4 * var(--spacing-control-base) + 3 * 4px + 12px",
    );
    expect(inset + 4 * control + 3 * 4 + 12).toBe(225);
    expect(calc("--spacing-tab-controls-collapsed-generic")).toBe(
      "8px + 4 * var(--spacing-control-base) + 3 * 4px + 8px",
    );
    expect(8 + 4 * control + 3 * 4 + 8).toBe(140);
  });

  test("Given the trio's arrive transition, When read, Then it is timed by the zone's own duration and curve", () => {
    const utility = CSS.slice(CSS.indexOf("@utility strip-trio-arrive"));
    const block = utility.slice(0, utility.indexOf("\n}\n"));
    expect(block).toContain("transition-duration: calc(var(--duration-base) * 2 / 3);");
    expect(block).toContain("transition-delay: calc(var(--duration-base) / 3);");
    expect(block).toContain("transition-timing-function: var(--ease-frame);");
    expect(block).toContain("@starting-style");
  });
});

describe("the strip's glyphs", () => {
  test("Given the strip, When its imports are read, Then the toggle and chevrons are ours, not lucide's", async () => {
    const strip = await Bun.file(join(SRC, "tab-strip.tsx")).text();
    const lucide = strip.match(/import \{([^}]+)\} from "lucide-react"/)?.[1] ?? "";
    expect(lucide.split(",").map((name) => name.trim())).toEqual(["Plus"]);
    expect(strip).toContain('from "./icons/sidebar-toggle"');
    expect(strip).toContain('from "./icons/chevron"');
  });
});

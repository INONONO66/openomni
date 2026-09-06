import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The Shell density contract, asserted on the token file.
 *
 * The owner's regression was a type-scale defect: the transcript rendered in
 * the sans prose ramp at 13px/1.7 instead of the mono ledger scale, and every
 * other gate stayed green while it did. Neither the compiler nor a snapshot of
 * class names can see a font-size, so the numbers themselves are pinned here.
 *
 * These are the values the reference capture
 * `.omo/reports/design-system-reset/shots/shell-dark-1280.png` was taken at.
 * Changing one means changing that contract deliberately, which is why the
 * assertion is exact equality rather than a range.
 */
const CSS = await Bun.file(join(import.meta.dir, "..", "src", "styles.css")).text();

/** The `[data-density="shell"]` block, isolated from the base scale. */
const SHELL = (() => {
  const at = CSS.indexOf('[data-density="shell"]');
  if (at === -1) throw new Error("the shell density block does not exist");
  const block = CSS.slice(at);
  return block.slice(0, block.indexOf("\n}"));
})();

/** The `@theme` block: the System (default) scale the Shell block re-points. */
const BASE = (() => {
  const at = CSS.indexOf("@theme {");
  if (at === -1) throw new Error("the @theme block does not exist");
  return CSS.slice(at, CSS.indexOf('[data-density="shell"]'));
})();

function px(block: string, token: string): number {
  const hit = block.match(new RegExp(`--text-${token}:\\s*(\\d+)px`));
  if (!hit?.[1]) throw new Error(`--text-${token} is not a px value in this block`);
  return Number(hit[1]);
}

function lineHeight(block: string, token: string): number {
  const hit = block.match(new RegExp(`--text-${token}--line-height:\\s*([\\d.]+)`));
  if (!hit?.[1]) throw new Error(`--text-${token}--line-height is not set in this block`);
  return Number(hit[1]);
}

/**
 * The roles the transcript actually renders, and the size each one is. A role
 * missing from this table is a role nobody agreed on.
 */
const ROLES = [
  { role: "body", size: 13, why: "the transcript's own text" },
  { role: "label", size: 13, why: "a row's own name" },
  { role: "heading", size: 13, why: "ranks by weight, not by size" },
  { role: "meta", size: 12, why: "a tool row, a reason line, a second line" },
  { role: "title", size: 14, why: "the session name heading the column" },
] as const;

describe("the shell density type scale", () => {
  test("Given the shell block, When each role is read, Then it is on its contracted size", () => {
    // 13px body / 12px meta is the density the reference capture was taken at.
    // A step either way is four rows of transcript per screen.
    for (const { role, size, why } of ROLES) {
      expect(px(SHELL, role), `--text-${role} (${why})`).toBe(size);
    }
  });

  test("Given the shell block, When body and meta are compared, Then meta is exactly one step quieter", () => {
    // The second line of a row must read as supporting the first, not as a
    // second first line. One step is the whole mechanism — there is no tone
    // change and no indent to carry it.
    expect(px(SHELL, "body") - px(SHELL, "meta")).toBe(1);
  });

  test("Given the shell block, When the header is compared to body, Then it is at most one step larger", () => {
    // The owner's report in one assertion: a session name is a label on the
    // column it heads, not a headline. Past one step above body it stops
    // ranking the header and starts shouting over the content.
    expect(px(SHELL, "title") - px(SHELL, "body")).toBeLessThanOrEqual(1);
    expect(px(SHELL, "title")).toBeGreaterThan(px(SHELL, "body"));
  });

  test("Given the shell block, When compared to the System scale, Then the ledger reads denser", () => {
    // Shell buys its density from LEADING and from the headline roles, not by
    // shrinking body text: 13px is already the floor for prose a person reads
    // all day, so the ledger keeps it and tightens the space around it.
    //
    // The roles that DO shrink are the ones that were shouting: `display` and
    // `title`. `label` deliberately RISES 12px → 13px, because in a mono ledger
    // a row's own name and the transcript's text are one tier, and pushing the
    // name below the prose would rank a row's identity beneath the words inside
    // it. So the claim is per-role and stated, not a blanket inequality.
    for (const role of ["display", "title"] as const) {
      expect(px(SHELL, role), `--text-${role} under shell`).toBeLessThan(px(BASE, role));
    }
    expect(px(SHELL, "body"), "body holds at the readable floor").toBe(px(BASE, "body"));
    expect(px(SHELL, "label"), "a row's name joins the body tier").toBeGreaterThan(
      px(BASE, "label"),
    );

    // ...and the surface as a whole must still be tighter: total vertical space
    // for one of each transcript role, which is what the owner actually sees.
    const stack = (block: string) =>
      ROLES.reduce((sum, { role }) => sum + px(block, role) * lineHeight(block, role), 0);
    expect(stack(SHELL)).toBeLessThan(stack(BASE));
  });

  test("Given the shell block, When leading is read, Then it is ledger-tight, never prose", () => {
    // Mono glyphs have uniform advance and no descender relief to buy back, so
    // prose leading spends a third of the column on air. 1.7 is the sans body
    // value and the exact thing the regression reintroduced.
    for (const role of ["body", "title", "heading", "label", "meta"] as const) {
      const measured = lineHeight(SHELL, role);
      expect(measured, `--text-${role}--line-height`).toBeLessThanOrEqual(1.45);
      expect(measured, `--text-${role}--line-height`).toBeGreaterThanOrEqual(1.2);
    }
  });

  test("Given the shell block, When the family is read, Then the surface is mono-first", () => {
    // The transcript is a ledger of machine truth read in long columns: paths,
    // tool names, durations, and code are the majority of its glyphs. Setting
    // it in the sans ramp is what made the shell read as a chat client.
    expect(SHELL).toContain("font-family: var(--font-mono)");
    expect(SHELL).not.toContain("var(--font-sans)");
  });

  test("Given the shell block, When inspected, Then it re-points type and rhythm only", () => {
    // Density is not a theme. The System and Shell tabs must stay one color
    // system, or the showcase is comparing two design systems.
    expect(SHELL).not.toContain("--color-");
    expect(SHELL).not.toContain("--radius-");
  });
});

describe("the System scale keeps its own reading", () => {
  test("Given the base scale, When read, Then body is sans prose at prose leading", () => {
    // The System tab is the design system's own documentation surface and
    // stays on the Pretendard ramp. Collapsing the two scales into one would
    // "fix" the regression by deleting the distinction instead.
    expect(px(BASE, "body")).toBe(13);
    expect(lineHeight(BASE, "body")).toBe(1.7);
    expect(BASE).toContain('--font-sans:\n    "Pretendard Variable"');
  });

  test("Given both blocks, When body leading is compared, Then shell is materially tighter", () => {
    expect(lineHeight(SHELL, "body")).toBeLessThan(lineHeight(BASE, "body"));
  });
});

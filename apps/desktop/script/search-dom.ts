/**
 * Reading the renderer's search surface out of a live page.
 *
 * Separated from the driving script so the two concerns stay legible: this
 * module knows how to INTERROGATE the DOM, and probe-search.ts knows what
 * sequence of keys to send and which claims to make about the answers.
 */

import type { Page } from "playwright";

/** The renderer's search field. */
export const FIELD = 'nav[aria-label="Sessions"] input';

/** ⌘K on macOS, Ctrl+K elsewhere — the accelerator the renderer registers. */
export const accelerator = () => (process.platform === "darwin" ? "Meta+k" : "Control+k");
/** Select-all, so the next keystrokes replace the query instead of appending. */
export const selectAll = () => (process.platform === "darwin" ? "Meta+a" : "Control+a");

/** A CSS color that paints nothing. */
export const isTransparent = (color: string) =>
  color === "transparent" || /,\s*0\)\s*$/.test(color);

export const arrayEq = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Whether the weight-only check has teeth: tint one matched run with the
 * system's accent, confirm the probe reports it, then put the run back.
 *
 * A negative assertion that cannot fail is worse than no assertion, because it
 * reads as coverage. This is the mutation that proves it can.
 */
export async function detectsChroma(page: Page): Promise<boolean> {
  const caught = await page.evaluate(() => {
    const run = document.querySelector<HTMLElement>(
      "nav[aria-label='Sessions'] [role='option'] span > span",
    );
    if (!run) return null;
    const before = run.style.color;
    run.style.color = "oklch(0.72 0.19 45)";
    const seen = getComputedStyle(run).color;
    run.style.color = before;
    return seen;
  });
  if (caught === null) return false;
  const oklch = /^oklch\(([\d.]+)\s+([\d.]+)/.exec(caught);
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(caught);
  if (oklch) return Number(oklch[2]) > 0.01;
  if (!rgb) return false;
  const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255 > 0.01;
}

/** Whether `inner` appears in `outer` in order — order preserved under filter. */
export function isSubsequence(inner: readonly string[], outer: readonly string[]): boolean {
  let cursor = 0;
  for (const value of outer) if (value === inner[cursor]) cursor += 1;
  return cursor === inner.length;
}

/**
 * The engine's whole sequence, settled rows included: every tail is opened, the
 * row ids are read, and the tails are put back. Filtering may only ever DROP
 * rows from this list, never reorder them.
 *
 * This runs BEFORE any query is typed, so the baseline is the resting tree
 * rather than a tree the probe has already narrowed.
 */
export async function fullSequence(page: Page): Promise<readonly string[]> {
  const tails = await page.getByRole("button", { name: /^settled/ }).all();
  for (const tail of tails) await tail.click();
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll("[role='option']")].map((row) =>
      row.id.replace("session-row-", ""),
    ),
  );
  for (const tail of tails) await tail.click();
  // Put the tree back the way it was found, or the resting frame already shot
  // above would no longer describe the page the later checks run against.
  await page.waitForFunction(
    (count) => document.querySelectorAll("[role='option']").length === count,
    ids.length - tails.length,
  );
  return ids;
}

/**
 * Every fact this probe asserts, read in one pass so they are consistent with
 * each other and with the frame just captured.
 */
export function probe(page: Page) {
  return page.evaluate((selector) => {
    const field = document.querySelector<HTMLInputElement>(selector);
    const nav = field?.closest("nav");
    const line = field?.closest("label");
    if (!field || !nav || !line) throw new Error("search field not found");

    const headers = [...nav.querySelectorAll("button[data-level='0']")];
    const header = headers[0]?.querySelector("span:not([aria-hidden])");
    const navX = nav.getBoundingClientRect().x;
    const lineStyle = getComputedStyle(line);
    const round = (value: number) => Math.round(value * 10) / 10;

    const controls = field.getAttribute("aria-controls");
    const rows = [...nav.querySelectorAll<HTMLElement>("[role='option']")];

    // A row with no L0 project header ABOVE it in its ancestry floated to the
    // root. This is the hierarchy claim, measured structurally rather than by
    // eye. It walks all the way up rather than checking one level, because a
    // row inside a settled tail is legitimately two disclosures deep: its
    // nearest group is the tail, whose own parent carries the project header.
    const headerFor = (row: Element): Element | null => {
      for (let node = row.parentElement; node !== null; node = node.parentElement) {
        const header = node.querySelector(":scope > button[data-level='0']");
        if (header !== null) return header;
      }
      return null;
    };
    const orphanRows = rows.filter((row) => headerFor(row) === null).length;

    // The highlight must carry no COLOR of its own. Matched glyphs do step up
    // the neutral foreground ramp (muted -> fg), which is a lightness change
    // on the same achromatic axis; what is forbidden is a fill, a decoration,
    // or any actual chroma, because the system's one hue is spent on live
    // state and the primary action. So chroma is what gets measured, not mere
    // difference from the surrounding text.
    const runs = [...nav.querySelectorAll<HTMLElement>("[role='option'] span > span")];
    const weighted = runs.filter((run) => Number(getComputedStyle(run).fontWeight) >= 500);
    const chromaOf = (color: string) => {
      const oklch = /^oklch\(([\d.]+)\s+([\d.]+)/.exec(color);
      if (oklch) return Number(oklch[2]);
      const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
      if (!rgb) return 0;
      const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
      // Grey has equal channels; the spread stands in for chroma.
      return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    };
    const paintOf = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const paints: string[] = [];
      if (!/,\s*0\)\s*$/.test(style.backgroundColor)) paints.push(`bg=${style.backgroundColor}`);
      if (chromaOf(style.color) > 0.01) paints.push(`chroma=${style.color}`);
      if (style.textDecorationLine !== "none") paints.push(`ul=${style.textDecorationLine}`);
      return paints;
    };

    const active = document.activeElement;
    return {
      height: Math.round(line.getBoundingClientRect().height),
      textX: round(field.getBoundingClientRect().x - navX),
      headerTextX: header ? round(header.getBoundingClientRect().x - navX) : null,
      fill: lineStyle.backgroundColor,
      radius: lineStyle.borderRadius,
      underlineColor: lineStyle.borderBottomColor,
      focused: active === field,
      value: field.value,
      hint: line.querySelector("[aria-hidden]")?.textContent ?? null,
      count: line.parentElement?.querySelector("[aria-live]")?.textContent ?? null,
      controlsResolves:
        field.getAttribute("role") === "combobox" &&
        controls !== null &&
        document.getElementById(controls) !== null,
      rows: rows.length,
      rowIds: rows.map((row) => row.id.replace("session-row-", "")),
      projectHeaders: headers.length,
      orphanRows,
      weightedRuns: weighted.length,
      highlightPaint: weighted.flatMap(paintOf),
      selectedRowSeparates: (() => {
        const row = nav.querySelector("[role='option'][aria-current='true']");
        const own = row === null ? [] : [...row.querySelectorAll<HTMLElement>("span > span")];
        if (own.length < 2) return true;
        // Both mechanisms are checked, because the selected row is the case
        // where each one can collapse on its own: it is already medium weight
        // AND already primary tone, so a highlight that relies on either
        // alone renders flat exactly there.
        const weights = new Set(own.map((run) => getComputedStyle(run).fontWeight));
        const tones = new Set(own.map((run) => getComputedStyle(run).color));
        return weights.size > 1 && tones.size > 1;
      })(),
      activeId: field.getAttribute("aria-activedescendant"),
      ariaSelected: nav.querySelector("[role='option'][aria-selected='true']")?.id ?? null,
      currentId:
        nav.querySelector("[role='option'][aria-current='true']")?.id.replace("session-row-", "") ??
        null,
      focusedRowId:
        active instanceof HTMLElement && active.getAttribute("role") === "option"
          ? active.id.replace("session-row-", "")
          : null,
      acceleratorListeners: window.__acceleratorListeners ?? null,
    };
  }, FIELD);
}

declare global {
  interface Window {
    /** Installed by the counting shim in probe-search.ts, before the bundle runs. */
    __acceleratorListeners?: number;
  }
}

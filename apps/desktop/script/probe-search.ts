/**
 * Drive the renderer's session search in a real browser and read the result
 * back out of the DOM.
 *
 * This exists because `bun test` has no `document`. The reducer that owns the
 * keyboard semantics is unit-tested directly, and the ARIA wiring is asserted
 * on rendered markup — but several claims in this feature are only true if a
 * real event loop agrees:
 *
 *   - ⌘K focuses the field from OUTSIDE it (a document-level listener).
 *   - that listener is attached ONCE, not once per render.
 *   - focus actually moves, and Esc actually hands it back to the tree.
 *   - the highlight is weight-only: no fill, no hue of its own.
 *   - the tree does not reflow while the field is focused.
 *
 * It probes the REAL renderer: the shipped `dist/renderer`, not a test-only
 * composition.
 *
 *   bun run --cwd apps/desktop probe:search <outDir>
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  accelerator,
  arrayEq,
  detectsChroma,
  FIELD,
  fullSequence,
  isSubsequence,
  isTransparent,
  probe,
  selectAll,
} from "./search-dom";

const ROOT = dirname(import.meta.dir);
const DIST = join(ROOT, "dist/renderer");
const THEMES = ["dark", "light"] as const;
/**
 * A query that narrows to a subset, and one that matches nothing.
 *
 * `lea` is the interesting narrowing case on this fixture: it keeps one LIVE
 * row and one row inside a SETTLED tail, so a single frame shows the hierarchy
 * surviving, a tail auto-expanding onto a match, and the weight-only highlight
 * at once. It also spans two match tiers — a prefix on `lease semantics`, a
 * scattered hit on `ledger append path`.
 */
const NARROWING = "lea";
const NO_MATCH = "zzzq";

async function main(): Promise<void> {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("dist/renderer is missing — run `bun run --cwd apps/desktop build`");
    process.exit(2);
  }

  const outDir = resolve(process.argv[2] ?? join(ROOT, "shots"));
  await mkdir(outDir, { recursive: true });

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      return new Response(Bun.file(join(DIST, path === "/" ? "index.html" : path)));
    },
  });

  const browser = await chromium.launch();
  let shots = 0;
  const failures: string[] = [];
  const backgrounds = new Map<string, string>();

  for (const theme of THEMES) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 860 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    // Count document keydown listeners from BEFORE the bundle runs, so the
    // "registered once" claim is measured rather than assumed. A handler
    // re-added on every render focuses the field just as well and is invisible
    // to every other check here.
    await page.addInitScript(() => {
      window.__acceleratorListeners = 0;
      const add = document.addEventListener.bind(document);
      const remove = document.removeEventListener.bind(document);
      document.addEventListener = ((type: string, ...rest: unknown[]) => {
        if (type === "keydown")
          window.__acceleratorListeners = (window.__acceleratorListeners ?? 0) + 1;
        return (add as (...args: unknown[]) => unknown)(type, ...rest);
      }) as typeof document.addEventListener;
      document.removeEventListener = ((type: string, ...rest: unknown[]) => {
        if (type === "keydown")
          window.__acceleratorListeners = (window.__acceleratorListeners ?? 0) - 1;
        return (remove as (...args: unknown[]) => unknown)(type, ...rest);
      }) as typeof document.removeEventListener;
    });
    await page.goto(`http://localhost:${server.port}`, { waitUntil: "load" });
    // `data-theme` on the root is the system's own switch (packages/ui/styles.css
    // scopes light to `:root[data-theme="light"]`). The renderer ships dark and
    // has no toggle, so the probe sets the attribute rather than clicking a
    // control that does not exist — and asserts the surface actually repainted,
    // because two identical frames labelled dark and light prove nothing.
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.evaluate(() => document.fonts.ready);
    await page.locator(FIELD).waitFor();
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    backgrounds.set(theme, background);

    const shoot = async (name: string) => {
      await page.screenshot({ path: join(outDir, `${name}-${theme}-1280.png`) });
      shots += 1;
    };
    const check = (claim: string, ok: boolean) => {
      console.log(`  ${ok ? "ok  " : "FAIL"}  ${claim}`);
      if (!ok) failures.push(`${theme}: ${claim}`);
    };
    /** Wait on the field's own value, so no step races the React commit. */
    const settled = (value: string) =>
      page.waitForFunction(
        ([selector, expected]) =>
          document.querySelector<HTMLInputElement>(selector as string)?.value === expected,
        [FIELD, value] as const,
      );

    console.log(`\ntheme=${theme}`);

    // ---- rest ------------------------------------------------------------
    const engineOrder = await fullSequence(page);
    const rest = await probe(page);
    await shoot("search-rest");
    check("at rest the line has no fill", isTransparent(rest.fill));
    check("at rest the line has no corner radius", rest.radius === "0px");
    check("at rest the underline is transparent", isTransparent(rest.underlineColor));
    check("the field hangs on the L0 header text x", rest.textX === rest.headerTextX);
    check("at rest the hint offers the entry shortcut", rest.hint === "⌘K");
    check("at rest there is no count line", rest.count === null);
    check("at rest no row is announced as active", rest.activeId === null);
    check("the field is a combobox over the tree it filters", rest.controlsResolves);
    check("the tree paints the whole fixture", rest.rows > 0);

    // ---- the accelerator, from outside the field -------------------------
    // Focus a row FIRST, or "the shortcut focused the field" is
    // indistinguishable from the field having been focused all along.
    await page.locator("[role='option']").first().focus();
    check("a row outside the field holds focus", !(await probe(page)).focused);
    await page.keyboard.press(accelerator());
    const focused = await probe(page);
    await shoot("search-focused");
    check("the accelerator focuses the field from outside it", focused.focused);
    check("on focus a hairline appears under the line", !isTransparent(focused.underlineColor));
    check("focus changes color only — the row height holds", focused.height === rest.height);
    check("focus adds no fill", isTransparent(focused.fill));
    // A handler added per render would still focus correctly above, so the
    // "registered once" claim has to be counted rather than inferred.
    check("the accelerator handler is registered once", focused.acceleratorListeners === 1);
    check("the accelerator does not disturb the tree", focused.rows === rest.rows);

    // ---- typing narrows --------------------------------------------------
    await page.keyboard.type(NARROWING);
    await settled(NARROWING);
    const typed = await probe(page);
    await shoot("search-typing");
    check(`typing "${NARROWING}" narrows the tree`, typed.rows > 0 && typed.rows < rest.rows);
    check("the hint switches to the exit key", typed.hint === "esc");
    check(
      "a count line reports the total",
      typed.count === `${typed.rows} result${typed.rows === 1 ? "" : "s"}`,
    );
    check("every surviving row still sits under a project header", typed.orphanRows === 0);
    check("non-matching projects are gone", typed.projectHeaders < rest.projectHeaders);
    check("matched glyphs are weighted", typed.weightedRuns > 0);
    check(
      `the highlight spends no color, fill, or decoration (${typed.highlightPaint.join(", ") || "clean"})`,
      typed.highlightPaint.length === 0,
    );
    // Guard against the check above passing because it cannot see anything:
    // paint an accent run into a matched span and confirm it is caught.
    check("the color check would catch an accent-tinted run", await detectsChroma(page));
    // Weight is the ONLY signal, so it has to survive the row that is already
    // set in medium weight: on the selected row an inheriting remainder would
    // render at the matched weight and the highlight would say nothing there.
    check("the highlight still separates runs on the selected row", typed.selectedRowSeparates);
    check("the field keeps the caret while filtering", typed.focused);
    // The baseline is the engine's FULL sequence, settled rows included: a
    // match inside a collapsed tail is not in the resting row list, so
    // comparing against what is merely painted at rest would mis-read a
    // correctly-placed settled row as having jumped.
    check(
      "the surviving rows hold their attention order",
      isSubsequence(typed.rowIds, engineOrder),
    );

    // ---- arrow traversal and commit --------------------------------------
    await page.keyboard.press("ArrowDown");
    const first = await probe(page);
    check(
      "ArrowDown activates a row without leaving the field",
      first.activeId !== null && first.focused,
    );
    check(
      "the announced row is the first result",
      first.activeId === `session-row-${first.rowIds[0]}`,
    );
    check(
      "the active row is marked selected for assistive tech",
      first.ariaSelected === first.activeId,
    );
    await page.keyboard.press("ArrowUp");
    check(
      "ArrowUp at the top clamps instead of wrapping",
      (await probe(page)).activeId === first.activeId,
    );
    await page.keyboard.press("Enter");
    const committed = await probe(page);
    check("Enter leaves the caret in the field", committed.focused);
    check("Enter keeps the query so narrowing can continue", committed.value === NARROWING);
    check("Enter drives the real selection", committed.currentId === first.rowIds[0]);
    check(
      "selecting from search does not reflow the tree",
      arrayEq(committed.rowIds, typed.rowIds),
    );

    // ---- zero results ----------------------------------------------------
    await page.keyboard.press(selectAll());
    await page.keyboard.type(NO_MATCH);
    await settled(NO_MATCH);
    const empty = await probe(page);
    await shoot("search-zero");
    check("a query matching nothing paints no rows", empty.rows === 0);
    check("zero results says so in one muted line", empty.count === "no sessions match");
    check("zero results adds no empty-state chrome", empty.projectHeaders === 0);
    check("zero results announces no active row", empty.activeId === null);

    // ---- Esc has two meanings --------------------------------------------
    await page.keyboard.press("Escape");
    await settled("");
    const cleared = await probe(page);
    check("Esc with text clears the query and keeps the caret", cleared.focused);
    check("clearing restores every row", cleared.rows === rest.rows);
    check("clearing restores the resting hint", cleared.hint === "⌘K");
    check("clearing removes the count line", cleared.count === null);
    await page.keyboard.press("Escape");
    const blurred = await probe(page);
    check("Esc on an empty field gives focus back to the tree", !blurred.focused);
    check(
      "focus lands on the selected row, not nowhere",
      blurred.focusedRowId === blurred.currentId,
    );

    await page.close();
  }

  await browser.close();
  server.stop();

  // Both themes were shot; if they rendered the same surface, the theme switch
  // silently did nothing and half the screenshots are mislabelled.
  const [dark, light] = [backgrounds.get("dark"), backgrounds.get("light")];
  console.log(`\ntheme backgrounds: dark=${dark} light=${light}`);
  if (dark === light) {
    failures.push(`both themes rendered ${dark} — the theme switch did nothing`);
  }

  if (failures.length > 0) {
    console.error(`\nFAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(`\nOK: ${shots} screenshot(s) in ${outDir}`);
}

await main();

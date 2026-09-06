/**
 * Drive the redesigned transcript in a real browser and read the result back
 * out of the DOM.
 *
 * Most of the redesign's laws are pure functions with unit tests — what
 * collapses, what merges, how far apart two blocks sit. This probe covers the
 * claims those tests structurally cannot reach, because they are about
 * COMPUTED LAYOUT and real events rather than about markup:
 *
 *   - the work group's rows are actually 24px with actually zero gap;
 *   - the spine is ONE unbroken stroke rather than N segments;
 *   - the status dots land on ONE x down the whole group;
 *   - `spacingBetween`'s four steps arrive as 4/8/12/24 real pixels;
 *   - the prompt is the only element in the column with a border;
 *   - clicking the header actually expands, and Enter/arrows reach it;
 *   - a gutter click actually sets `location.hash` and rings the row.
 *
 * It probes the REAL renderer, like `probe-search.ts`, and for the same reason:
 * the showcase renders a static composition, and probing that would assert the
 * composition rather than the surface the Owner sees.
 *
 *   bun run --cwd apps/desktop probe:timeline <outDir>
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { chromium, type Page } from "playwright";

const ROOT = dirname(import.meta.dir);
const DIST = join(ROOT, "dist/renderer");
const THEMES = ["dark", "light"] as const;

/** The 24px row step and the four spacing steps, as the tokens promise them. */
const ROW_HEIGHT = 24;
const STEPS = [4, 8, 12, 24];

interface Reading {
  readonly rowHeights: readonly number[];
  readonly rowGaps: readonly number[];
  readonly spineXs: readonly number[];
  readonly spineSpans: readonly (readonly [number, number])[];
  readonly statusXs: readonly number[];
  readonly collisions: readonly string[];
  readonly borderedTags: readonly string[];
  readonly promptBoxes: number;
  readonly blockGaps: readonly number[];
  readonly headerLabel: string | null;
  readonly headerExpanded: string | null;
  readonly workRows: number;
  readonly anchors: readonly string[];
  readonly anchorText: readonly string[];
  readonly footers: readonly string[];
  readonly stamps: number;
  readonly promptMarkerDrawn: boolean;
  readonly promptMarkerAccent: boolean;
  readonly liveDots: number;
  readonly stoppedDots: number;
}

async function read(page: Page): Promise<Reading> {
  return page.evaluate(() => {
    const all = <T extends Element>(selector: string) => [
      ...document.querySelectorAll<T>(selector),
    ];
    const round = (value: number) => Math.round(value * 100) / 100;

    const rows = all<HTMLElement>("[data-work-row]");
    const rects = rows.map((row) => row.getBoundingClientRect());

    const spines = all<HTMLElement>("[data-work-spine] > span");
    const spineRects = spines.map((spine) => spine.getBoundingClientRect());

    // Every top-level block in the column, in order, so the gaps between them
    // can be measured against the four steps.
    //
    // A block's own rect is not the measurement: `spacingClass` puts the step on
    // a MARGIN, and margins sit outside the border box, so consecutive rects
    // report the gap correctly only because each wrapper is a bare div. What has
    // to be excluded is the delegation disclosure, which is not a turn block and
    // whose internal rhythm is the tree's rather than the transcript's.
    // Scoped by the column's own marker, not by `.max-w-measure` — the main
    // header is bounded by the same measure, and reading its two children as
    // transcript blocks measured a gap no spacing rule produced.
    const column = document.querySelector<HTMLElement>("[data-transcript-column]");
    const blocks =
      column === null
        ? []
        : [...column.children]
            .filter((child) => child.querySelector('[role="tree"]') === null)
            .map((child) => child.getBoundingClientRect());

    return {
      rowHeights: rects.map((rect) => round(rect.height)),
      // Gap between consecutive rows: the next row's top minus this row's
      // bottom. Zero is the claim — rows abut so the spine is continuous.
      rowGaps: rects.slice(1).map((rect, index) => round(rect.top - (rects[index]?.bottom ?? 0))),
      spineXs: spineRects.map((rect) => round(rect.left)),
      spineSpans: spineRects.map((rect) => [round(rect.top), round(rect.bottom)] as const),
      statusXs: all<HTMLElement>("[data-work-row] [data-status-dot]").map((dot) =>
        round(dot.getBoundingClientRect().left),
      ),
      // Does any row's prose actually touch its status column? The fixed 11ch
      // slot only separates the two if the content beside it yields; a `meta`
      // that refused to shrink ran `cancelled at 2.1s` straight into `stopped`
      // with no gap, and every structural assertion still passed.
      collisions: rows
        .map((row) => {
          // The LAST text node in the prose half, not the half's own box: the
          // wrapper is `flex-1` and always ends flush against the status slot,
          // so measuring it reports 0px whether or not any glyph is there.
          const prose = row.querySelector<HTMLElement>("[data-work-prose]");
          const slot = row.querySelector<HTMLElement>("[data-work-status]");
          if (prose === null || slot === null) return null;
          const painted = [...prose.children]
            .map((child) => child.getBoundingClientRect())
            .filter((rect) => rect.width > 0);
          const lastRect = painted[painted.length - 1];
          if (lastRect === undefined) return null;
          const gap = slot.getBoundingClientRect().left - lastRect.right;
          return gap < 2 ? `${row.textContent?.trim().slice(0, 40)} (${round(gap)}px)` : null;
        })
        .filter((entry): entry is string => entry !== null),
      // Which elements in the transcript draw a VISIBLE border. Width alone is
      // not the question: a row with `border-transparent` reserves the pixel so
      // its geometry does not shift on hover, and reading that as a box would
      // report a frame nobody can see. The box law is about what is PAINTED.
      borderedTags: all<HTMLElement>("[data-transcript-column] *")
        .filter((el) => {
          const style = getComputedStyle(el);
          const sides = [
            [style.borderTopWidth, style.borderTopColor],
            [style.borderRightWidth, style.borderRightColor],
            [style.borderBottomWidth, style.borderBottomColor],
            [style.borderLeftWidth, style.borderLeftColor],
          ] as const;
          return sides.some(
            ([width, color]) =>
              width !== "0px" && color !== "transparent" && !/,\s*0\s*\)$/.test(color),
          );
        })
        .map((el) =>
          el.getAttribute("data-prompt-box") !== null
            ? "prompt"
            : el.closest("pre, [data-gutter-line], .bg-sunken") !== null || el.matches("pre")
              ? "code"
              : el.getAttribute("data-work-spine") !== null ||
                  el.getAttribute("data-drawn-mark") !== null ||
                  el.closest("[data-work-spine], [data-tree-connector], [data-epoch-rule]") !== null
                ? "drawn"
                : `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 60)}`,
        ),
      promptBoxes: all("[data-prompt-box]").length,
      blockGaps: blocks
        .slice(1)
        .map((rect, index) => round(rect.top - (blocks[index]?.bottom ?? 0)))
        .filter((gap) => gap > 0),
      headerLabel: document.querySelector("[data-work-header]")?.textContent ?? null,
      headerExpanded:
        document.querySelector("[data-work-header]")?.getAttribute("aria-expanded") ?? null,
      workRows: rows.length,
      anchors: all<HTMLElement>("[data-anchor]").map((el) => el.dataset.anchor ?? ""),
      // Anchors must be DATA, never text: a paragraph selection must copy the
      // paragraph, not an identifier glued to it.
      anchorText: (document.body.innerText.match(/\bt\d+\.\d+\b/g) ?? []) as string[],
      footers: all<HTMLElement>("[data-turn-footer]").map((el) => el.textContent ?? ""),
      // Per-block timestamps are gone; a bare clock reading survives only at a
      // gapped turn's head. Counted by CONTENT rather than by position — the
      // question is "how many bare clock readings are in this column", and a
      // positional selector answers a different one that happens to correlate.
      // The epoch rule's own meta is excluded: it dates a ledger boundary, not
      // a turn.
      stamps: all<HTMLElement>("[data-transcript-column] span").filter(
        (el) =>
          /^\d{2}:\d{2}$/.test(el.textContent ?? "") && el.closest("[data-epoch-rule]") === null,
      ).length,
      promptMarkerDrawn:
        document.querySelector("[data-prompt-marker] svg") !== null &&
        !/[\u276f\u203a\u25b6]/.test(document.body.innerText),
      promptMarkerAccent: (() => {
        const marker = document.querySelector<HTMLElement>("[data-prompt-marker]");
        if (marker === null) return false;
        const accent = getComputedStyle(document.documentElement)
          .getPropertyValue("--color-accent")
          .trim();
        return accent !== "" && getComputedStyle(marker).color === accentToRgb(accent);
        function accentToRgb(value: string): string {
          const probeEl = document.createElement("span");
          probeEl.style.color = value;
          document.body.append(probeEl);
          const resolved = getComputedStyle(probeEl).color;
          probeEl.remove();
          return resolved;
        }
      })(),
      liveDots: all('[data-work-row] [data-status-dot="running"]').length,
      stoppedDots: all('[data-work-row] [data-status-dot="slashed"]').length,
    };
  });
}

async function main(): Promise<void> {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("dist/renderer is missing — run `bun run --cwd apps/desktop build`");
    process.exit(2);
  }

  const outDir = resolve(process.argv[2] ?? join(ROOT, "shots/timeline"));
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
    await page.goto(`http://localhost:${server.port}`, { waitUntil: "load" });
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.evaluate(() => document.fonts.ready);
    await page.locator("[data-work-group]").first().waitFor();
    backgrounds.set(
      theme,
      await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    );

    const shoot = async (name: string) => {
      await page.screenshot({ path: join(outDir, `${name}-${theme}-1280.png`) });
      shots += 1;
    };
    const check = (claim: string, ok: boolean) => {
      console.log(`  ${ok ? "ok  " : "FAIL"}  ${claim}`);
      if (!ok) failures.push(`${theme}: ${claim}`);
    };

    console.log(`\ntheme=${theme}`);

    // ---- collapsed, the default -----------------------------------------
    const collapsed = await read(page);
    await shoot("shell-collapsed");

    check("the transcript renders a work group", collapsed.workRows > 0);
    check(
      `every work row is ${ROW_HEIGHT}px (${[...new Set(collapsed.rowHeights)].join(", ")})`,
      collapsed.rowHeights.every((height) => Math.abs(height - ROW_HEIGHT) < 0.5),
    );
    check(
      `rows abut with zero gap (${[...new Set(collapsed.rowGaps)].join(", ") || "none"})`,
      collapsed.rowGaps.every((gap) => Math.abs(gap) < 0.5),
    );
    check(
      "the spine holds ONE x down the group",
      new Set(collapsed.spineXs.map((x) => Math.round(x))).size === 1,
    );
    // Adjacent spine cells must share an edge, or the "one unbroken stroke"
    // claim is really N segments that happen to line up.
    check(
      "consecutive spine cells join into one stroke",
      collapsed.spineSpans.slice(1).every((span, index) => {
        const previous = collapsed.spineSpans[index];
        return previous !== undefined && Math.abs(span[0] - previous[1]) < 0.5;
      }),
    );
    check(
      "every status dot lands on one x",
      new Set(collapsed.statusXs.map((x) => Math.round(x))).size === 1,
    );
    check(
      `no row's prose touches its status column (${collapsed.collisions.join("; ") || "clean"})`,
      collapsed.collisions.length === 0,
    );

    // ---- the box law ------------------------------------------------------
    const unexpected = collapsed.borderedTags.filter(
      (tag) => tag !== "prompt" && tag !== "code" && tag !== "drawn",
    );
    check("the transcript boxes at least one prompt", collapsed.promptBoxes > 0);
    check(
      `the prompt is the only boxed element (${unexpected.join(", ") || "clean"})`,
      unexpected.length === 0,
    );
    check("the prompt marker is drawn, never a character", collapsed.promptMarkerDrawn);
    check("the prompt marker takes the accent", collapsed.promptMarkerAccent);

    // ---- relational spacing ----------------------------------------------
    const offGrid = collapsed.blockGaps.filter(
      (gap) => !STEPS.some((step) => Math.abs(gap - step) < 1),
    );
    check(
      `every block gap is one of ${STEPS.join("/")}px (off: ${offGrid.join(", ") || "none"})`,
      offGrid.length === 0,
    );
    // Anti-vacuity for the check above: "every gap is one of four steps" is
    // trivially true if the column only ever uses one of them. The ledger
    // fixture opens on an epoch rule and runs a single turn, so it should show
    // the 24px epoch gap AND the 8px in-turn gap at minimum.
    const usedSteps = [...new Set(collapsed.blockGaps.map((gap) => Math.round(gap)))].sort(
      (a, b) => a - b,
    );
    check(
      `the column uses more than one step (${usedSteps.join(", ") || "none"})`,
      usedSteps.length > 1,
    );

    // ---- the never-hide rule, on screen ----------------------------------
    check("the collapsed group still shows the running row", collapsed.liveDots === 1);
    check("the collapsed group still shows the stopped row", collapsed.stoppedDots === 1);
    check(
      `the header states what it hides (${collapsed.headerLabel ?? "none"})`,
      /\+\d+ earlier/.test(collapsed.headerLabel ?? "") &&
        /total/.test(collapsed.headerLabel ?? ""),
    );
    check("the header reports itself collapsed", collapsed.headerExpanded === "false");

    // ---- the turn footer --------------------------------------------------
    // The ledger fixture's turn is still streaming, so it prints NO footer:
    // both of the footer's numbers are totals of something still accumulating.
    check("a live turn prints no footer", collapsed.footers.length === 0);
    check("no per-block timestamp survives on a consecutive turn", collapsed.stamps <= 1);

    // ---- anchors ----------------------------------------------------------
    check("every row carries an anchor", collapsed.anchors.length > 0);
    check(
      "anchors follow t<turn>.<row>",
      collapsed.anchors.every((anchor) => /^t\d+\.\d+$/.test(anchor)),
    );
    check(
      `no anchor is rendered as text (${collapsed.anchorText.join(", ") || "clean"})`,
      collapsed.anchorText.length === 0,
    );

    // A gutter click must do BOTH halves: address the row and ring it. The
    // clipboard half is a permission the probe cannot grant headlessly, so the
    // hash is the observable one.
    const firstAnchor = collapsed.anchors[0] ?? "";
    await page.locator(`[data-anchor-gutter="${firstAnchor}"]`).click();
    await page.waitForFunction((expected) => window.location.hash === `#${expected}`, firstAnchor);
    const ringed = await page.evaluate((anchor) => {
      const row = document.getElementById(anchor);
      return row === null ? "" : getComputedStyle(row).boxShadow;
    }, firstAnchor);
    check(`clicking the gutter addresses the row (#${firstAnchor})`, true);
    check("the hash-targeted row wears the focus ring", ringed.includes("inset"));

    // ---- expansion --------------------------------------------------------
    await page.locator("[data-work-header]").first().click();
    await page.waitForFunction(
      (before) => document.querySelectorAll("[data-work-row]").length > before,
      collapsed.workRows,
    );
    const expanded = await read(page);
    await shoot("shell-expanded");

    check("clicking the header expands the group", expanded.workRows > collapsed.workRows);
    check(
      `expanded rows keep the ${ROW_HEIGHT}px step`,
      expanded.rowHeights.every((height) => Math.abs(height - ROW_HEIGHT) < 0.5),
    );
    check(
      "the spine still holds one x when expanded",
      new Set(expanded.spineXs.map((x) => Math.round(x))).size === 1,
    );
    // The anchors of rows that were already visible must not have moved: an
    // address that changes when a disclosure opens is an address nobody can cite.
    const kept = collapsed.anchors.filter((anchor) => anchor.includes("."));
    check(
      "expanding renumbers nothing",
      kept.every((anchor) => expanded.anchors.includes(anchor)),
    );
    check("a merged row reports its count", /\u00d7\d/.test(await page.innerText("body")));

    // ---- keyboard ---------------------------------------------------------
    // The arrows must reach the same disclosure the click did, and they match
    // the tree's gesture beside them: a reader who learned it on one should not
    // have to relearn it on the other.
    //
    // Each step waits on the row COUNT reaching its expected value rather than
    // on a relative comparison — a relative wait that is already satisfied when
    // the key is pressed returns instantly and asserts nothing.
    const rowCount = () => page.locator("[data-work-row]").count();
    const waitRows = (target: number) =>
      page.waitForFunction(
        (want) => document.querySelectorAll("[data-work-row]").length === want,
        target,
      );

    // Focused ONCE. The group has a single header that persists across the
    // state change, so a keyboard user keeps their place — and asserting that
    // by pressing both keys without re-focusing is the whole point: an earlier
    // shape rendered two headers in two positions, and collapsing unmounted the
    // element holding focus so the next key landed on the body.
    await page.locator("[data-work-header]").first().focus();
    await page.keyboard.press("ArrowLeft");
    await waitRows(collapsed.workRows);
    check(`ArrowLeft collapses the group (${await rowCount()} rows)`, true);

    await page.keyboard.press("ArrowRight");
    await waitRows(expanded.workRows);
    check(`ArrowRight expands it again (${await rowCount()} rows)`, true);
    check(
      "the toggle keeps focus across the state change",
      await page.evaluate(() => document.activeElement?.getAttribute("data-work-header") !== null),
    );

    // ---- the settled default ---------------------------------------------
    // A session that is not running collapses one level further: every done row
    // folds and only the header line remains. `kernel-lease` is settled.
    //
    // Reached through the SEARCH field rather than by clicking the row, because
    // a settled session lives inside a collapsed tail in the navigator — which
    // is the attention engine working correctly, and is exactly the path a
    // reader would take to get there.
    await page.locator('nav[aria-label="Sessions"] input').fill("lease");
    await page.locator("#session-row-kernel-lease").click();
    await page.locator("[data-turn-footer]").first().waitFor();
    const settled = await read(page);
    await shoot("shell-settled");

    check("a settled session closes each turn with a footer", settled.footers.length > 0);
    check(
      `the footer reports elapsed time and tokens (${settled.footers[0] ?? ""})`,
      /\[turn: .+\]/.test(settled.footers[0] ?? ""),
    );
    check("a settled session states the gapped turn's clock time", settled.stamps > 0);

    await page.close();
  }

  await browser.close();
  server.stop();

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

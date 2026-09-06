/**
 * The two Owner rulings, measured in a real browser rather than asserted.
 *
 * Static markup tests pin the class strings and the document order; neither can
 * say what a reader actually sees. These are the two facts a screenshot is
 * evidence for and a `renderToStaticMarkup` assertion is not:
 *
 *   - **The turn boundary is the largest gap in the column.** Measured as the
 *     real vertical distance between the bottom of one turn and the top of the
 *     next, against every gap INSIDE a turn. Ruling 1 exists because 28px did
 *     not win by enough; a test that only compares constants would have agreed
 *     with 28 just as happily.
 *   - **The time is the last line of the agent's block, flush with its text
 *     edge, 8px above it, and visible at rest.** All four are geometry. The
 *     `left` is the one the markup cannot check at all: `ms-4` on a tool group
 *     and no indent on the time render as different x with identical HTML
 *     nesting.
 *
 * Exits 1 on violation, so it is a gate and not a report.
 *
 *   bun run --cwd packages/ui showcase:probe-turn-time
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const DIST = join(import.meta.dir, "dist");
const THEMES = ["dark", "light"] as const;

/** The law's own numbers, as the probe expects to measure them. */
const TURN_GAP = 40;
const BLOCK_GAP = 8;
/** Sub-pixel layout and font metrics; the gaps themselves are integers. */
const EPSILON = 1.5;

interface Reading {
  readonly theme: string;
  readonly turnBoundary: number;
  readonly largestInsideTurn: number;
  readonly timeGap: number;
  readonly timeLeftDelta: number;
  readonly timeOpacity: string;
  readonly timeIsLast: boolean;
  readonly timeSize: string;
}

async function main(): Promise<void> {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("showcase/dist is missing — run `bun run --cwd packages/ui showcase:build`");
    process.exit(2);
  }

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      return new Response(Bun.file(join(DIST, path === "/" ? "index.html" : path)));
    },
  });
  const origin = `http://localhost:${server.port}`;

  const browser = await chromium.launch();
  const readings: Reading[] = [];

  for (const theme of THEMES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await page.goto(origin, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await page
      .getByRole("button", { name: theme === "dark" ? "Dark" : "Light", exact: true })
      .click();
    await page.getByRole("button", { name: "Shell", exact: true }).click();
    await page.getByRole("button", { name: "Shell", exact: true, pressed: true }).waitFor();
    await page.locator("[data-turn-time]").first().waitFor({ state: "visible" });

    readings.push({
      theme,
      ...(await page.evaluate(() => {
        const transcript = document.querySelector("[data-transcript]");
        if (transcript === null) throw new Error("no transcript");
        const turns = [...transcript.querySelectorAll("[data-turn]")];
        if (turns.length < 2) throw new Error("need two turns to measure a boundary");

        /** The gap between two boxes, as rendered. */
        const between = (above: Element, below: Element) =>
          below.getBoundingClientRect().top - above.getBoundingClientRect().bottom;

        // The boundary: bottom of the LAST DRAWN LINE of turn N to the top of
        // the first drawn line of turn N+1.
        //
        // Measured child-to-child rather than wrapper-to-wrapper, and that is
        // load-bearing: the turn wrapper is a plain block, so its first child's
        // 40px top margin sits INSIDE its own border box and every
        // wrapper-to-wrapper distance reads as 0. Measuring the boxes that
        // actually carry ink is what makes this the gap a reader sees.
        const edge = (turn: Element, which: "first" | "last") => {
          const kids = [...turn.children];
          const kid = which === "first" ? kids[0] : kids[kids.length - 1];
          if (kid === undefined) throw new Error("an empty turn");
          return kid;
        };
        const boundaries = turns
          .slice(1)
          .map((turn, at) => between(edge(turns[at] as Element, "last"), edge(turn, "first")));

        // Every gap inside a turn: consecutive direct children, all turns.
        const inside: number[] = [];
        for (const turn of turns) {
          const parts = [...turn.children];
          for (let at = 1; at < parts.length; at += 1) {
            inside.push(between(parts[at - 1] as Element, parts[at] as Element));
          }
        }

        // The time: the last child of its turn, and where it sits.
        const time = document.querySelector("[data-turn-time]");
        if (time === null) throw new Error("no turn time on screen");
        const turn = time.closest("[data-turn]");
        if (turn === null) throw new Error("the time is not inside a turn");

        const previous = time.previousElementSibling;
        if (previous === null) throw new Error("the time opens its turn instead of closing it");

        // Flush with the AGENT text edge — the transcript column's own left,
        // not the tool block's 16px indent.
        const style = getComputedStyle(time);

        return {
          turnBoundary: Math.min(...boundaries),
          largestInsideTurn: Math.max(...inside.filter((gap) => gap > 0)),
          timeGap: between(previous, time),
          timeLeftDelta:
            time.getBoundingClientRect().left - transcript.getBoundingClientRect().left,
          timeOpacity: style.opacity,
          timeIsLast: turn.lastElementChild === time,
          timeSize: `${style.fontSize}/${style.lineHeight}`,
        };
      })),
    });

    await page.close();
  }

  await browser.close();
  server.stop();

  const bad: string[] = [];
  for (const r of readings) {
    console.log(
      `${r.theme.padEnd(6)} turnBoundary=${r.turnBoundary} largestInsideTurn=${r.largestInsideTurn} ` +
        `ratio=${(r.turnBoundary / r.largestInsideTurn).toFixed(2)}`,
    );
    console.log(
      `       timeGap=${r.timeGap} timeLeftDelta=${r.timeLeftDelta} opacity=${r.timeOpacity} ` +
        `last=${r.timeIsLast} size=${r.timeSize}`,
    );

    if (Math.abs(r.turnBoundary - TURN_GAP) > EPSILON) {
      bad.push(`${r.theme}: turn boundary is ${r.turnBoundary}px, not ${TURN_GAP}px`);
    }
    if (r.turnBoundary <= r.largestInsideTurn) {
      bad.push(
        `${r.theme}: the turn boundary (${r.turnBoundary}px) does not beat the largest gap inside a turn (${r.largestInsideTurn}px)`,
      );
    }
    if (Math.abs(r.timeGap - BLOCK_GAP) > EPSILON) {
      bad.push(`${r.theme}: the time sits ${r.timeGap}px above its block, not ${BLOCK_GAP}px`);
    }
    if (Math.abs(r.timeLeftDelta) > EPSILON) {
      bad.push(`${r.theme}: the time is ${r.timeLeftDelta}px off the agent text edge`);
    }
    if (r.timeOpacity !== "1") {
      bad.push(`${r.theme}: the time is not visible at rest (opacity ${r.timeOpacity})`);
    }
    if (!r.timeIsLast) bad.push(`${r.theme}: the time is not its turn's last child`);
    if (r.timeSize !== "12px/18px") {
      bad.push(`${r.theme}: the time is ${r.timeSize}, not the 12/18 meta voice`);
    }
  }

  if (bad.length > 0) {
    console.error(`\nFAIL:\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
  console.log(
    "\nOK: the turn boundary is the loudest gap and the time closes the response at rest",
  );
}

await main();

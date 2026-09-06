/**
 * Assert the transcript's LAST turn is fully visible above the composer.
 *
 * The defect this gates was invisible to every test in the suite and to the
 * markup itself: the second turn rendered correctly, in the right order, with
 * the right classes — and sat 114px below the fold, because the scroll viewport
 * opened at the top and nothing ever moved it. `renderToStaticMarkup` cannot
 * see that; it has no viewport, no scroll position, and no composer to be
 * hidden behind. Only a real layout, at a real size, can be asked whether the
 * newest turn is on screen.
 *
 * The assertion is the one the Owner named: **the bottom of the last transcript
 * row is above the top of the composer**, with the tail's own text actually
 * inside the scroll viewport. It runs in both states, because the approval tray
 * docks above the composer and takes ~44px out of the column — a tail that
 * clears the composer at rest can be swallowed the moment a decision arrives,
 * which is precisely when losing it costs the most.
 *
 *   bun run --cwd packages/ui showcase:probe-transcript-tail
 *
 * Exits 1 on violation, so it is a gate rather than a report.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const DIST = join(import.meta.dir, "dist");
const THEMES = ["dark", "light"] as const;

interface Tail {
  /** Bottom edge of the last thing rendered in the transcript. */
  readonly lastRowBottom: number;
  /** Top edge of the input zone — composer, or the tray when one is docked. */
  readonly composerTop: number;
  /** Bottom edge of the scrolling viewport. */
  readonly viewportBottom: number;
  /** The tail's prompt text, to prove the row measured is the one that was missing. */
  readonly tailText: string;
  /** Whether the tail's tool row reports the pending decision. */
  readonly waitingVisible: boolean;
  readonly waitingBottom: number | null;
}

async function measure(page: Page): Promise<Tail> {
  return (await page.evaluate(() => {
    const transcript = document.querySelector("[data-transcript]");
    if (!transcript) throw new Error("no transcript on screen");

    // The scroll owner is found by scrolling ability rather than by class, so
    // the probe keeps working if the primitive's markup changes.
    let viewport = transcript.parentElement;
    while (viewport && viewport.scrollHeight <= viewport.clientHeight + 1) {
      viewport = viewport.parentElement;
    }

    const turns = [...transcript.querySelectorAll("[data-turn]")];
    const last = turns.at(-1);
    if (!last) throw new Error("no turns on screen");

    // The composer owns the textarea; from it, the input zone is the outermost
    // block that is still below the transcript.
    const field = document.querySelector("textarea");
    if (!field) throw new Error("no composer on screen");
    let zone: HTMLElement = field;
    while (zone.parentElement && zone.parentElement.querySelector("[data-transcript]") === null) {
      zone = zone.parentElement;
    }

    const waiting = [...last.querySelectorAll("*")].find((node) =>
      (node.textContent ?? "").trim().startsWith("waiting for approval"),
    );

    return {
      lastRowBottom: last.getBoundingClientRect().bottom,
      composerTop: zone.getBoundingClientRect().top,
      viewportBottom: viewport?.getBoundingClientRect().bottom ?? Number.NaN,
      tailText: (last.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 64),
      waitingVisible: waiting !== undefined,
      waitingBottom: waiting?.getBoundingClientRect().bottom ?? null,
    };
  })) as Tail;
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

  const browser = await chromium.launch();
  const failures: string[] = [];

  for (const theme of THEMES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await page.goto(`http://localhost:${server.port}`, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole("button", { name: theme === "dark" ? "Dark" : "Light" }).click();
    await page.getByRole("button", { name: "Shell", exact: true }).click();
    await page.getByRole("button", { name: "Shell", exact: true, pressed: true }).waitFor();
    await page.locator("[data-transcript]").waitFor();

    // The tray state is the shipped one for this fixture; dismissing the
    // decision yields the idle state. Both are measured, in that order, because
    // approving CHANGES the column height and the pin has to survive it.
    for (const state of ["tray", "idle"] as const) {
      if (state === "idle") {
        // Targeted by `data-approve` rather than by its label: the tray's own
        // test hook is stable, and a probe that breaks when the button's caption
        // is reworded is a probe measuring the copy.
        await page.locator("[data-approve]").click();
        // Wait for the tray to actually leave the layout rather than for a
        // duration: the measurement is only meaningful once it is gone.
        await page.locator("[data-approval-tray]").waitFor({ state: "detached" });
      }

      const tail = await measure(page);
      const label = `${theme}/${state}`;
      const gap = tail.composerTop - tail.lastRowBottom;

      console.log(
        `${label.padEnd(12)} lastRowBottom=${tail.lastRowBottom.toFixed(1)} ` +
          `composerTop=${tail.composerTop.toFixed(1)} gap=${gap.toFixed(1)} ` +
          `viewportBottom=${tail.viewportBottom.toFixed(1)}\n` +
          `${" ".repeat(12)} tail="${tail.tailText}"`,
      );

      // THE assertion.
      if (!(tail.lastRowBottom < tail.composerTop)) {
        failures.push(
          `${label}: last row bottom ${tail.lastRowBottom.toFixed(1)} is not above composer top ${tail.composerTop.toFixed(1)}`,
        );
      }
      // ...and it must be inside the viewport, not merely above the composer:
      // a row clipped by the scroll box also satisfies the inequality.
      if (!(tail.lastRowBottom <= tail.viewportBottom + 1)) {
        failures.push(
          `${label}: last row bottom ${tail.lastRowBottom.toFixed(1)} is clipped by viewport bottom ${tail.viewportBottom.toFixed(1)}`,
        );
      }
      // The prompt text the Owner reported missing must be on screen, not just
      // its `you` label.
      if (!tail.tailText.includes("Run the suite")) {
        failures.push(`${label}: the tail's prompt text is not rendered — got "${tail.tailText}"`);
      }
      if (state === "tray") {
        if (!tail.waitingVisible) {
          failures.push(`${label}: the tail's "waiting for approval" row is absent`);
        } else if (tail.waitingBottom !== null && tail.waitingBottom > tail.composerTop) {
          failures.push(
            `${label}: "waiting for approval" bottom ${tail.waitingBottom.toFixed(1)} is behind the tray at ${tail.composerTop.toFixed(1)}`,
          );
        }
      }
    }

    await page.close();
  }

  await browser.close();
  server.stop();

  if (failures.length > 0) {
    console.error(`\nFAIL: the transcript tail is not fully visible\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nOK: the last turn clears the composer in both themes and both states");
}

await main();

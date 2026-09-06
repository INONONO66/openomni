/**
 * Screenshot the inspector, mid-inspection.
 *
 * Separate from `shoot.ts` because this capture is a GESTURE, not a view: the
 * overlay only exists while Alt is held and the pointer is over an element, so
 * the frame has to be taken with the keyboard and mouse in a specific state.
 * Folding that into the general harness would put a modifier-key dance inside a
 * loop whose whole job is to visit every viewport and theme.
 *
 *   bun run --cwd packages/ui showcase:shoot:inspector [outFile]
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";

const DIST = join(import.meta.dir, "dist");

/** The element the shot is framed on: the fold line of a tool block. */
const SUBJECT = '[data-ui="ToolGroup.Summary"]';

async function main(): Promise<void> {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("showcase/dist is missing — run `bun run --cwd packages/ui showcase:build`");
    process.exit(2);
  }

  const outFile = resolve(
    process.argv[2] ?? join(import.meta.dir, "shots", "inspector", "inspector-dark-1280.png"),
  );
  await mkdir(dirname(outFile), { recursive: true });

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      return new Response(Bun.file(join(DIST, path === "/" ? "index.html" : path)));
    },
  });
  const origin = `http://localhost:${server.port}`;

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
  });

  await page.goto(origin, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  // `exact`, because a tool row's summary legitimately reads "... · 1 shell" and
  // a substring match would resolve the tab button and the transcript together.
  await page.getByRole("button", { name: "Shell", exact: true }).click();
  await page.getByRole("button", { name: "Shell", exact: true, pressed: true }).waitFor();

  const subject = page.locator(SUBJECT).first();
  await subject.waitFor();
  await subject.scrollIntoViewIfNeeded();

  // Alt goes down BEFORE the pointer moves. The inspector reads `altKey` off the
  // mousemove itself, so a keydown after the move would leave the overlay unbuilt
  // until something else nudged the pointer.
  await page.keyboard.down("Alt");
  await subject.hover();

  // Wait for the readout to exist rather than for a duration: the overlay is
  // painted from a React state update, and a timer here would be a guess that
  // gets slower machines wrong and still races on fast ones.
  const readout = page.locator("[data-inspector-readout]");
  await readout.waitFor({ state: "visible" });

  // The chain must actually name the subject, or the shot is of the overlay
  // pointing somewhere else — which would look correct and prove nothing.
  const chain = (await readout.textContent()) ?? "";
  if (!chain.includes("ToolGroup.Summary")) {
    console.error(`the readout names "${chain}", not ToolGroup.Summary`);
    process.exit(1);
  }

  await page.screenshot({ path: outFile });
  await page.keyboard.up("Alt");

  await browser.close();
  server.stop();
  console.log(`OK: ${outFile}\n  chain: ${chain}`);
}

await main();

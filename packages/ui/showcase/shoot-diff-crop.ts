/**
 * Shoot the code fence ALONE, tight, in both themes.
 *
 * The Shell frames prove the fence sits correctly in the column; they cannot
 * prove the thing this pass changed, because the marker bar is 2px wide and the
 * gap between it and the line number is 4px. At 1280 across a full window those
 * are three pixels of a 2560px frame — visible only as a smudge, and a reviewer
 * asked to confirm "the bar sits immediately left of the number" would be
 * guessing.
 *
 * So the fence is captured by its own bounding box at 4x, which is the scale
 * where a 2px bar is 8 device pixels and the 4px gap is measurable by eye. The
 * crop is taken from the SAME rendered page as the Shell frames rather than from
 * an isolated specimen mount: a fence shot in a fixture of its own would be
 * evidence about the fixture.
 *
 *   bun run --cwd packages/ui showcase:shoot-diff-crop [outDir]
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const DIST = join(import.meta.dir, "dist");
const THEMES = ["dark", "light"] as const;

/**
 * 4x rather than the 2x the Shell frames take. The subject is a 2px bar and a
 * 4px gap; at 2x they are 4 and 8 device pixels, which is legible but not
 * measurable, and the whole point of this crop is that the gap can be checked
 * against the rule rather than accepted on assertion.
 */
const SCALE = 4;

async function main(): Promise<void> {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("showcase/dist is missing — run `bun run --cwd packages/ui showcase:build`");
    process.exit(2);
  }

  const outDir = resolve(process.argv[2] ?? join(import.meta.dir, "shots", "transcript-fix"));
  await mkdir(outDir, { recursive: true });

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      return new Response(Bun.file(join(DIST, path === "/" ? "index.html" : path)));
    },
  });
  const origin = `http://localhost:${server.port}`;

  const browser = await chromium.launch();
  const written: string[] = [];

  for (const theme of THEMES) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 860 },
      deviceScaleFactor: SCALE,
    });
    await page.goto(origin, { waitUntil: "load" });
    // Fonts, not a timer: the gutter is tabular mono and a frame taken mid-swap
    // measures the fallback face, which would misreport the very column
    // alignment this crop exists to show.
    await page.evaluate(() => document.fonts.ready);
    await page
      .getByRole("button", { name: theme === "dark" ? "Dark" : "Light", exact: true })
      .click();

    await page.getByRole("button", { name: "Shell", exact: true }).click();
    await page.getByRole("button", { name: "Shell", exact: true, pressed: true }).waitFor();

    // The fence is found by the diff row it contains rather than by a nth-child
    // path, so it keeps working when the fixture's transcript changes shape.
    const marked = page.locator("[data-mark='add']").first();
    await marked.waitFor();
    const fence = page
      .locator("pre")
      .filter({ has: page.locator("[data-mark='add']") })
      .first();
    await fence.scrollIntoViewIfNeeded();

    // Park the pointer: a hovered row draws its anchor number and its own
    // surface, and this crop is evidence about the resting state of a diff.
    await page.mouse.move(0, 0);

    const shot = `code-diff-${theme}-crop.png`;
    await fence.screenshot({ path: join(outDir, shot) });
    written.push(shot);

    await page.close();
  }

  await browser.close();
  server.stop();
  console.log(`OK: ${written.length} crop(s) in ${outDir}\n  ${written.join("\n  ")}`);
}

await main();

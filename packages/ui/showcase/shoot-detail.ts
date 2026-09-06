/**
 * Shoot the modern pass's DETAIL evidence: a 2x device-pixel crop of the
 * sidebar's selected row together with the settled tail's connector elbow.
 *
 * This is a separate capture from `shoot-tui` because the two answer different
 * questions. That script frames the delegation tree to prove the connector
 * COLUMN reads as a column; this one frames the sidebar to prove the two
 * softened edges introduced by this pass — a selected row's 6px corner with its
 * hairline border, and the elbow's 3px turn — hold up at their real render
 * size. Both are sub-pixel claims: a 1px border at 1.35:1 and a 3px arc on a
 * 1px stroke are invisible in a scaled-down full-page frame, which is exactly
 * where a soft-focused edge or a squared-off corner would hide.
 *
 *   bun run --cwd packages/ui showcase:shoot-detail <outDir>
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const DIST = join(import.meta.dir, "dist");
const THEMES = ["dark", "light"] as const;

async function main(): Promise<void> {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("showcase/dist is missing — run `bun run --cwd packages/ui showcase:build`");
    process.exit(2);
  }

  const outDir = resolve(process.argv[2] ?? join(import.meta.dir, "shots"));
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
      deviceScaleFactor: 2,
    });
    await page.goto(origin, { waitUntil: "load" });
    // Fonts, not a timer: a frame taken mid-swap measures the fallback family
    // and misreports every glyph column's advance width.
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole("button", { name: theme === "dark" ? "Dark" : "Light" }).click();

    await page.getByRole("button", { name: "Shell" }).click();
    await page.getByRole("button", { name: "Shell", pressed: true }).waitFor();

    // Open every settled tail: the L2 rows under it are the sidebar's only
    // connector cells, and a closed tail hides the elbow being inspected.
    for (const tail of await page.getByRole("button", { name: /settled/ }).all()) {
      if ((await tail.getAttribute("aria-expanded")) === "true") continue;
      await tail.click();
      await tail.and(page.locator("[aria-expanded=true]")).waitFor();
    }

    // The sidebar column itself, framed from its own bounding box rather than
    // by hardcoded pixels: the crop has to follow the layout, not assume it.
    const sidebar = page.getByRole("navigation", { name: "Sessions" });
    await sidebar.waitFor();
    const box = await sidebar.boundingBox();

    if (box) {
      // The selected row and the first settled tail both live in the upper
      // half of the column, so a 420px-tall frame from the search line down
      // carries the selected surface AND an elbow in one image.
      const crop = `selected-row-elbow-2x-${theme}.png`;
      await page.screenshot({
        path: join(outDir, crop),
        clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 420) },
      });
      written.push(crop);
    }

    await page.close();
  }

  await browser.close();
  server.stop();
  console.log(`OK: ${written.length} screenshot(s) in ${outDir}\n  ${written.join("\n  ")}`);
}

await main();

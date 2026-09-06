/**
 * Screenshot the showcase.
 *
 * The design system's claim is visual, so the review artifact has to be visual
 * too. This serves the built bundle rather than the dev server: a screenshot of
 * something HMR patched in memory is not a screenshot of what ships.
 *
 *   bun run --cwd packages/ui showcase:shoot [outDir]
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const DIST = join(import.meta.dir, "dist");
const VIEWPORTS = [
  { name: "1280", width: 1280, height: 860 },
  { name: "768", width: 768, height: 900 },
] as const;
const THEMES = ["dark", "light"] as const;
const VIEWS = ["System", "Shell"] as const;

/**
 * Sections shot on their own, in addition to the full page.
 *
 * A full-page System capture is 6000px tall, which makes any single section a
 * few percent of the image — unreviewable for exactly the details these
 * sections exist to show, where the whole claim rests on the shape of a
 * connector at 12px. Element-scoped shots frame the section at its real render
 * size so the glyphs can actually be inspected.
 *
 * Only shot at the 1280 viewport: these are reference crops, and the same
 * section at 768 is the same specimens in a narrower column, which the
 * full-page 768 capture already records.
 */
const SECTIONS = ["glyphs", "tui", "rejected"] as const;

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
      const file = Bun.file(join(DIST, path === "/" ? "index.html" : path));
      return new Response(file);
    },
  });
  const origin = `http://localhost:${server.port}`;

  const browser = await chromium.launch();
  const written: string[] = [];

  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
      });
      await page.goto(origin, { waitUntil: "load" });
      // Fonts, not a timer: a screenshot taken mid-swap measures the fallback
      // family and silently misreports the type scale.
      await page.evaluate(() => document.fonts.ready);
      await page.getByRole("button", { name: theme === "dark" ? "Dark" : "Light" }).click();

      for (const view of VIEWS) {
        await page.getByRole("button", { name: view }).click();
        await page.getByRole("button", { name: view, pressed: true }).waitFor();

        const name = `${view.toLowerCase()}-${theme}-${viewport.name}.png`;
        await page.screenshot({
          path: join(outDir, name),
          fullPage: view === "System",
        });
        written.push(name);

        if (view !== "System" || viewport.name !== "1280") continue;
        for (const section of SECTIONS) {
          const element = page.locator(`#${section}`);
          await element.waitFor();
          // `scrollIntoViewIfNeeded` first: Playwright screenshots an element
          // by scrolling to it anyway, and doing it explicitly means the
          // sticky section nav has settled before the frame is taken.
          await element.scrollIntoViewIfNeeded();
          const sectionName = `system-${section}-${theme}-${viewport.name}.png`;
          await element.screenshot({ path: join(outDir, sectionName) });
          written.push(sectionName);
        }
      }
      await page.close();
    }
  }

  await browser.close();
  server.stop();
  console.log(`OK: ${written.length} screenshot(s) in ${outDir}\n  ${written.join("\n  ")}`);
}

await main();

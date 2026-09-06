/**
 * Shoot the sidebar's search line and read its resting/focus geometry back out
 * of the browser.
 *
 * The claim is that the line is a LINE — no fill, no frame — that hangs on the
 * L0 text x and draws a hairline only while it is taking input. Every one of
 * those is a computed-style fact, so it is measured rather than eyeballed, and
 * the focus state is captured as its own frame because a resting screenshot
 * cannot show a treatment that only exists on focus.
 *
 * This probe covers the PRIMITIVE's geometry only. The search behaviour it
 * fronts — the accelerator, filtering, the count line, arrow traversal — lives
 * in the app that owns the data, and is probed by
 * apps/desktop/script/probe-search.ts against the real renderer.
 *
 *   bun run --cwd packages/ui showcase:probe-search <outDir>
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

  const browser = await chromium.launch();

  for (const theme of THEMES) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 860 },
      deviceScaleFactor: 2,
    });
    await page.goto(`http://localhost:${server.port}`, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole("button", { name: theme === "dark" ? "Dark" : "Light" }).click();
    await page.getByRole("button", { name: "Shell" }).click();
    await page.getByRole("button", { name: "Shell", pressed: true }).waitFor();

    const read = () =>
      page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Sessions"]');
        const field = nav?.querySelector("input");
        const line = field?.closest("label");
        const header = nav?.querySelector("button[data-level='0'] span:not([aria-hidden])");
        if (!nav || !field || !line || !header) throw new Error("search line not found");

        const navX = nav.getBoundingClientRect().x;
        const lineStyle = getComputedStyle(line);
        const fieldStyle = getComputedStyle(field);

        return {
          height: Math.round(line.getBoundingClientRect().height),
          textX: Math.round((field.getBoundingClientRect().x - navX) * 10) / 10,
          headerTextX: Math.round((header.getBoundingClientRect().x - navX) * 10) / 10,
          fill: lineStyle.backgroundColor,
          radius: lineStyle.borderRadius,
          underline: `${lineStyle.borderBottomWidth} ${lineStyle.borderBottomColor}`,
          caret: fieldStyle.caretColor,
          focused: document.activeElement === field,
        };
      });

    const rest = await read();
    await page.locator('nav[aria-label="Sessions"] input').focus();
    await page.screenshot({ path: join(outDir, `after-search-focus-${theme}-1280.png`) });
    const focus = await read();

    console.log(`\ntheme=${theme}`);
    for (const [state, probe] of [
      ["rest ", rest],
      ["focus", focus],
    ] as const) {
      console.log(
        `  ${state}  h=${probe.height}  textX=${probe.textX} (L0 header textX=${probe.headerTextX})  ` +
          `fill=${probe.fill}  radius=${probe.radius}  underline=${probe.underline}  ` +
          `caret=${probe.caret}  focused=${probe.focused}`,
      );
    }

    await page.close();
  }

  await browser.close();
  server.stop();
  console.log(`\nOK: 2 screenshot(s) in ${outDir}`);
}

await main();

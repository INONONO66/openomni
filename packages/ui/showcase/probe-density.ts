/**
 * Measure the Shell transcript's TYPE, per role, in the shipped bundle.
 *
 * The owner's report is a type-scale claim ("the text per tab became way too
 * big"), and a type-scale claim cannot be settled from a screenshot: a 13px
 * mono line and a 15px sans line at the same measure look similar at a glance
 * and differ by four rows of transcript per screen. So this reads the computed
 * `font-size` / `font-family` / `line-height` back out of the browser for each
 * role the Shell view renders, in BOTH tabs — because the regression is a
 * density scope defect, and a scope defect is only visible when the two tabs
 * are measured side by side.
 *
 *   bun run --cwd packages/ui showcase:probe-density
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const DIST = join(import.meta.dir, "dist");
const VIEWS = ["System", "Shell"] as const;

interface Measured {
  readonly role: string;
  readonly size: string;
  readonly family: string;
  readonly lineHeight: string;
  readonly weight: string;
  readonly text: string;
}

/**
 * The roles are located by what they ARE in the surface, not by a test id: the
 * transcript's body prose, its tool row, its header. A probe that needs markup
 * hooks measures the hooks instead of the design system.
 */
async function measure(page: Page): Promise<readonly Measured[]> {
  return (await page.evaluate(() => {
    const read = (role: string, element: Element | null): unknown => {
      if (!element) return { role, size: "-", family: "-", lineHeight: "-", weight: "-", text: "" };
      const style = getComputedStyle(element);
      return {
        role,
        size: style.fontSize,
        family: (style.fontFamily.split(",")[0] ?? "").replace(/"/g, ""),
        lineHeight: style.lineHeight,
        weight: style.fontWeight,
        text: (element.textContent ?? "").trim().slice(0, 32),
      };
    };

    const main = document.querySelector("main");
    const scope = main ?? document.body;
    const paragraphs = Array.from(scope.querySelectorAll("p"));
    const toolRow = scope.querySelector("button[data-level]");

    return [
      read("root", document.documentElement),
      read("header title", scope.querySelector("header span")),
      read("body prose", paragraphs[0] ?? null),
      read("heading", scope.querySelector("h2")),
      read("tool name", toolRow?.querySelector("span") ?? null),
      read("tool row", toolRow),
      read("code fence", scope.querySelector("pre") ?? scope.querySelector("code")),
    ];
  })) as readonly Measured[];
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(`http://localhost:${server.port}`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);

  for (const view of VIEWS) {
    await page.getByRole("button", { name: view }).click();
    await page.getByRole("button", { name: view, pressed: true }).waitFor();

    const density = await page.evaluate(
      () =>
        document.querySelector("[data-density]")?.getAttribute("data-density") ?? "(none applied)",
    );

    console.log(`\n=== ${view} tab — data-density=${density} ===`);
    console.log("role            size    family            line-height  weight  text");
    for (const row of await measure(page)) {
      console.log(
        `${row.role.padEnd(15)} ${row.size.padStart(6)}  ${row.family.padEnd(17)} ${row.lineHeight.padStart(
          11,
        )}  ${row.weight.padStart(6)}  ${row.text}`,
      );
    }
  }

  await browser.close();
  server.stop();
}

await main();

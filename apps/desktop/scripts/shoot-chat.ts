/**
 * Capture the built desktop renderer while the mock ChatTransport streams, then
 * again once the chat returns to ready. This exercises the shipped renderer,
 * not a dev-server or test-only composition.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const RENDERER = join(import.meta.dir, "..", "dist", "renderer");
const REPORTS = join(import.meta.dir, "..", "..", "..", ".omo", "reports", "ai-sdk");
const STREAMING_SHOT = join(REPORTS, "mock-stream.png");
const READY_SHOT = join(REPORTS, "mock-ready.png");

async function main(): Promise<void> {
  if (!existsSync(join(RENDERER, "index.html"))) {
    console.error("desktop/dist/renderer is missing - run `bun run build` first");
    process.exit(2);
  }

  await mkdir(REPORTS, { recursive: true });
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      const relative = pathname === "/" ? "index.html" : pathname.slice(1);
      if (relative.includes("..")) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(join(RENDERER, relative)));
    },
  });
  const browser = await chromium.launch().catch((error: Error) => {
    server.stop();
    throw error;
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 860 },
      deviceScaleFactor: 2,
    });
    await page.goto(`http://localhost:${server.port}`, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);

    await page.getByRole("option", { name: /slack driver/ }).click();
    await page.getByLabel("Message").fill("Show a streamed mock reply.");
    await page.getByLabel("Message").press("Enter");

    // The stop action exists only while `useChat` reports a submitted or
    // streaming turn. It is the exact state transition this capture proves.
    await page.getByRole("button", { name: "Stop response" }).waitFor();
    await page.screenshot({ path: STREAMING_SHOT });

    await page.waitForFunction(
      () =>
        document.querySelector("[data-stop]") === null &&
        document.body.textContent?.includes("mock transport is streaming this reply") === true,
    );
    await page.screenshot({ path: READY_SHOT });
    await page.close();
  } finally {
    await browser.close();
    server.stop();
  }

  console.log(`OK: ${STREAMING_SHOT}\nOK: ${READY_SHOT}`);
}

await main();

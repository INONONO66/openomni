/**
 * Shoot the rebuilt transcript, in both themes, as the review evidence.
 *
 * Three frames per theme, and each one exists to show a rule that the other two
 * cannot:
 *
 *   - **shell-idle** — the column at rest. This is the frame the whole rebuild
 *     is judged on, because the claim is about what the transcript looks like
 *     when nothing is happening: no boxes, no rules, no status column, and the
 *     turn boundary as the loudest whitespace on screen. A surface that only
 *     looks calm while something is running has not solved anything. The turn's
 *     time IS on screen here — one meta line closing each answer — and the frame
 *     is what proves it stays quiet at 40%.
 *   - **shell-tray** — the same column with a decision pending. It carries the
 *     accent budget: exactly one filled control on screen, docked above the
 *     composer, with the matching tool row reporting `waiting for approval` and
 *     offering no decision of its own.
 *   - **system-transcript** — the System page's specimen section: the three
 *     voices and the four rhythm steps, side by side at their real values. The
 *     Shell frames show the law applied; this one shows the law itself, which
 *     is what makes a disagreement about it reviewable.
 *
 * Both themes, because the accent is theme-dependent and the light ramp is
 * where a tone that is merely quiet in dark becomes a tone that is missing.
 *
 *   bun run --cwd packages/ui showcase:shoot-transcript [outDir]
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const DIST = join(import.meta.dir, "dist");
const THEMES = ["dark", "light"] as const;
const VIEWPORT = { name: "1280", width: 1280, height: 860 } as const;

async function main(): Promise<void> {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("showcase/dist is missing — run `bun run --cwd packages/ui showcase:build`");
    process.exit(2);
  }

  const outDir = resolve(process.argv[2] ?? join(import.meta.dir, "shots", "transcript"));
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
      viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
      deviceScaleFactor: 2,
    });
    await page.goto(origin, { waitUntil: "load" });
    // Fonts, not a timer: a frame taken mid-swap measures the fallback family
    // and silently misreports the whole type scale — which, in a pass whose
    // entire subject is three type sizes, would invalidate every shot.
    await page.evaluate(() => document.fonts.ready);
    await page
      .getByRole("button", { name: theme === "dark" ? "Dark" : "Light", exact: true })
      .click();

    // --- Shell, with the tray up ---------------------------------------
    //
    // Captured FIRST, because the fixture starts with a decision pending and
    // the idle frame is produced by resolving it. Shooting idle first would
    // mean re-mounting the tab to get the tray back.
    // `exact: true` matters: the tab is named "Shell" and a fold summary in the
    // fixture reads `4 tools · 2 read · 1 edit · 1 shell`, so a substring match
    // finds two buttons and the shoot fails on the ambiguity.
    await page.getByRole("button", { name: "Shell", exact: true }).click();
    await page.getByRole("button", { name: "Shell", exact: true, pressed: true }).waitFor();

    const tray = page.locator("[data-approval-tray]");
    await tray.waitFor();

    const withTray = `shell-tray-${theme}-${VIEWPORT.name}.png`;
    await page.screenshot({ path: join(outDir, withTray) });
    written.push(withTray);

    // --- Shell, at rest -------------------------------------------------
    //
    // Approving is what clears the tray, and the wait is for the tray to be
    // GONE rather than for a duration: a fixed delay here is a coin flip on a
    // slow machine, and a coin flip that usually lands right is worse than a
    // failure because it only misfires in CI.
    await page.locator("[data-approve]").click();
    await tray.waitFor({ state: "detached" });

    // Park the pointer off the transcript before the idle frame.
    //
    // The click above leaves the mouse resting inside a turn. The time no longer
    // reveals on hover — it is drawn at rest — so this is no longer about the
    // timestamp, but a resting frame with a hovered row in it still misreports
    // the row's colour, and "at rest" is what the frame claims to be.
    await page.mouse.move(0, 0);
    // The time is a normal in-flow line now, so it is waited for the way any
    // other element is: it must be THERE. The previous wait polled computed
    // opacity to catch the reveal mid-fade, which is a mechanism this pass
    // deleted — keeping it would have waited forever on `opacity: 1`.
    await page.locator("[data-turn-time]").first().waitFor({ state: "visible" });

    const idle = `shell-idle-${theme}-${VIEWPORT.name}.png`;
    await page.screenshot({ path: join(outDir, idle) });
    written.push(idle);

    // --- System, the specimen section -----------------------------------
    await page.getByRole("button", { name: "System", exact: true }).click();
    await page.getByRole("button", { name: "System", exact: true, pressed: true }).waitFor();

    const section = page.locator("#transcript");
    await section.waitFor();
    await section.scrollIntoViewIfNeeded();

    const specimen = `system-transcript-${theme}-${VIEWPORT.name}.png`;
    await page.screenshot({ path: join(outDir, specimen) });
    written.push(specimen);

    await page.close();
  }

  await browser.close();
  server.stop();
  console.log(`OK: ${written.length} screenshot(s) in ${outDir}\n  ${written.join("\n  ")}`);
}

await main();

import { createRequire } from "node:module";
import { _electron, expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as string;
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
delete environment.ELECTRON_RENDERER_URL;

test("production desktop shell boots with its bridge and CSP", async () => {
  const errors: string[] = [];
  const electron = await _electron.launch({
    executablePath: electronExecutable,
    cwd: process.cwd(),
    args: ["--disable-gpu", "dist/main/index.js"],
    env: environment,
  });
  try {
    const page = await electron.firstWindow({ timeout: 15_000 });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await expect(page).toHaveTitle("OpenOmni Desktop");
    const root = page.locator('[data-ui="Console.Content"]');
    await expect(root).toBeVisible();
    const bounds = await root.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.width).toBeGreaterThan(0);
    expect(bounds?.height).toBeGreaterThan(0);
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(csp).toContain("connect-src");
    expect(csp).toContain("font-src");
    const requireType = await page.evaluate("typeof require");
    const bridge = await page.evaluate(() => ({
      keys: Object.keys(window.desktop).sort(),
      versions: window.desktop.versions,
      gateway: typeof window.desktop.gateway,
    }));
    expect(bridge.keys).toEqual(["gateway", "onShellCommand", "versions"]);
    expect(bridge.gateway).toBe("function");
    expect(bridge.versions.electron).toBeTruthy();
    expect(requireType).toBe("undefined");
    expect(errors).toEqual([]);
  } finally {
    await electron.close();
  }
});

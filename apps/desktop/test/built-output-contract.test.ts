import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const dist = join(import.meta.dir, "../dist");

function required(path: string): string {
  const file = join(dist, path);
  if (!existsSync(file)) throw new Error(`Built desktop output is missing at ${file}; run bun run --cwd apps/desktop build first.`);
  return readFileSync(file, "utf8");
}

describe("built desktop security contracts", () => {
  test("built renderer retains the CSP", () => {
    const html = required("renderer/index.html");
    const document = new Window().document;
    document.body.innerHTML = html;
    const policies = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
    expect(policies).toHaveLength(1);
    const content = policies[0]?.getAttribute("content") ?? "";
    expect(content).toContain("connect-src");
    expect(content).toContain("font-src");
    expect(content).not.toContain("unsafe-eval");
    expect(content).not.toMatch(/https?:\/\//);
  });

  test("built preload keeps electron external", () => {
    const preload = required("preload/index.cjs");
    expect(preload).toMatch(/require\(["']electron["']\)/);
    expect(preload).not.toMatch(/node_modules[\\/]electron/);
    expect(preload).toContain("contextBridge");
  });
});

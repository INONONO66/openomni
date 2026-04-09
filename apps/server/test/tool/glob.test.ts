import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@openomni/protocol";
import { createGlobTool } from "../../src/tool/builtins/glob";

const tmpRoot = join(import.meta.dir, ".tmp-glob-test");
const workspace = join(tmpRoot, "workspace");
const outside = join(tmpRoot, "outside");

function makeCall(input: Record<string, unknown>): Tool.Call {
  return { id: crypto.randomUUID(), tool: "glob", input };
}

beforeAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(join(workspace, "nested"), { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(join(workspace, "root.ts"), "root");
  writeFileSync(join(workspace, "root.md"), "root");
  writeFileSync(join(workspace, "nested", "child.ts"), "child");
  writeFileSync(join(outside, "escape.ts"), "escape");

  const now = Date.now() / 1000;
  utimesSync(join(workspace, "root.ts"), now - 20, now - 20);
  utimesSync(join(workspace, "nested", "child.ts"), now - 10, now - 10);
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("glob tool", () => {
  const tool = createGlobTool(workspace);

  it("matches ts files in a directory", async () => {
    const result = await tool.execute(makeCall({ pattern: "*.ts", path: workspace }));

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.output)).toEqual([join(workspace, "root.ts")]);
  });

  it("matches recursively with double star", async () => {
    const result = await tool.execute(makeCall({ pattern: "**/*.ts", path: workspace }));

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.output)).toEqual([
      join(workspace, "nested", "child.ts"),
      join(workspace, "root.ts"),
    ]);
  });

  it("returns empty array when nothing matches", async () => {
    const result = await tool.execute(
      makeCall({ pattern: "*.md", path: join(workspace, "nested") }),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.output)).toEqual([]);
  });

  it("blocks workspace escape", async () => {
    const result = await tool.execute(makeCall({ pattern: "**/*.ts", path: "../outside" }));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("sorts results by newest first", async () => {
    const result = await tool.execute(makeCall({ pattern: "**/*.ts", path: workspace }));

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.output)).toEqual([
      join(workspace, "nested", "child.ts"),
      join(workspace, "root.ts"),
    ]);
  });

  it("caps results at 100", async () => {
    for (let index = 0; index < 101; index += 1) {
      const file = join(workspace, `bulk-${String(index).padStart(3, "0")}.ts`);
      writeFileSync(file, String(index));
      const stamp = Date.now() / 1000 - index;
      utimesSync(file, stamp, stamp);
    }

    const result = await tool.execute(makeCall({ pattern: "bulk-*.ts", path: workspace }));

    expect(result.isError).toBeFalsy();
    const output = JSON.parse(result.output) as string[];
    expect(output).toHaveLength(100);
    expect(output[0]).toBe(join(workspace, "bulk-000.ts"));
    expect(output).not.toContain(join(workspace, "bulk-100.ts"));
  });
});

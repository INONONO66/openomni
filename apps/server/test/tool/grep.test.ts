import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@openomni/protocol";
import { createGrepTool } from "../../src/tool/builtins/grep";

const tmpRoot = join(import.meta.dir, ".tmp-grep-test");
const workspace = join(tmpRoot, "workspace");
const outside = join(tmpRoot, "outside");

function makeCall(input: Record<string, unknown>): Tool.Call {
  return { id: crypto.randomUUID(), tool: "grep.search", input };
}

beforeAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("createGrepTool", () => {
  it("finds matching lines with a regex pattern", async () => {
    writeFileSync(join(workspace, "a.txt"), "alpha\nbeta\n");
    writeFileSync(join(workspace, "b.txt"), "gamma\nalpha delta\n");

    const tool = createGrepTool(workspace);
    const result = await tool.execute(makeCall({ pattern: "alpha" }));

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.output)).toEqual([
      { file: join(workspace, "a.txt"), line: 1, text: "alpha" },
      { file: join(workspace, "b.txt"), line: 2, text: "alpha delta" },
    ]);
  });

  it("limits searched files with include filters", async () => {
    writeFileSync(join(workspace, "match.ts"), "target\n");
    writeFileSync(join(workspace, "skip.txt"), "target\n");

    const tool = createGrepTool(workspace);
    const result = await tool.execute(makeCall({ pattern: "target", include: "*.ts" }));

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.output)).toEqual([
      { file: join(workspace, "match.ts"), line: 1, text: "target" },
    ]);
  });

  it("matches case-insensitively when ignoreCase is true", async () => {
    writeFileSync(join(workspace, "case.txt"), "FoObAr\n");

    const tool = createGrepTool(workspace);
    const result = await tool.execute(makeCall({ pattern: "foobar", ignoreCase: true }));

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.output)).toEqual([
      { file: join(workspace, "case.txt"), line: 1, text: "FoObAr" },
    ]);
  });

  it("caps results at 100 matches", async () => {
    for (let index = 0; index < 120; index += 1) {
      writeFileSync(join(workspace, `file-${index}.txt`), "needle\n");
    }

    const tool = createGrepTool(workspace);
    const result = await tool.execute(makeCall({ pattern: "needle" }));

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.output)).toHaveLength(100);
  });

  it("blocks workspace escape attempts", async () => {
    const tool = createGrepTool(workspace);
    const result = await tool.execute(makeCall({ pattern: "needle", path: "../outside" }));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });
});

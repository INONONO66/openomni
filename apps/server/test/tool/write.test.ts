import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@openomni/protocol";
import { createWriteTool } from "../../src/tool/builtins/write";

const tmpRoot = join(import.meta.dir, ".tmp-write-tool-test");
const workspace = join(tmpRoot, "workspace");
const outside = join(tmpRoot, "outside");

function makeCall(input: Record<string, unknown>): Tool.Call {
  return {
    id: crypto.randomUUID(),
    tool: "write",
    input,
  };
}

beforeAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(workspace, "existing.txt"), "old");
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("createWriteTool", () => {
  const tool = createWriteTool(workspace);

  it("writes a new file", async () => {
    const result = await tool.execute(makeCall({ path: "new.txt", content: "hello" }));

    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(workspace, "new.txt"), "utf8")).toBe("hello");
  });

  it("creates parent directories for nested paths", async () => {
    const result = await tool.execute(makeCall({ path: "a/b/c.txt", content: "nested" }));

    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(workspace, "a/b/c.txt"), "utf8")).toBe("nested");
  });

  it("blocks workspace escape attempts", async () => {
    const result = await tool.execute(makeCall({ path: "../../etc/foo", content: "nope" }));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("overwrites existing files", async () => {
    const result = await tool.execute(makeCall({ path: "existing.txt", content: "new" }));

    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(workspace, "existing.txt"), "utf8")).toBe("new");
  });
});

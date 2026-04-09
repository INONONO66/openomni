import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@openomni/protocol";
import { createEditTool } from "../../src/tool/builtins/edit";

const tmpRoot = join(import.meta.dir, ".tmp-edit-tool-test");
const workspace = join(tmpRoot, "workspace");
const outside = join(tmpRoot, "outside");

function makeCall(input: Record<string, unknown>): Tool.Call {
  return {
    id: crypto.randomUUID(),
    tool: "edit",
    input,
  };
}

beforeAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("edit tool", () => {
  const tool = createEditTool(workspace);

  it("replaces the first exact string match", async () => {
    const filePath = join(workspace, "note.txt");
    writeFileSync(filePath, "hello world");

    const result = await tool.execute(
      makeCall({ path: "note.txt", oldString: "world", newString: "bun" }),
    );

    expect(result.isError).toBeFalsy();
    expect(await Bun.file(filePath).text()).toBe("hello bun");
  });

  it("replaces all matches when replaceAll is true", async () => {
    const filePath = join(workspace, "repeat.txt");
    writeFileSync(filePath, "foo bar foo");

    const result = await tool.execute(
      makeCall({ path: "repeat.txt", oldString: "foo", newString: "baz", replaceAll: true }),
    );

    expect(result.isError).toBeFalsy();
    expect(await Bun.file(filePath).text()).toBe("baz bar baz");
  });

  it("fails when the old string is missing", async () => {
    writeFileSync(join(workspace, "missing.txt"), "hello world");

    const result = await tool.execute(
      makeCall({ path: "missing.txt", oldString: "bun", newString: "code" }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("not found");
  });

  it("fails when the file does not exist", async () => {
    const result = await tool.execute(
      makeCall({ path: "absent.txt", oldString: "a", newString: "b" }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("does not exist");
  });

  it("blocks workspace escape", async () => {
    const result = await tool.execute(
      makeCall({ path: "../outside/secret.txt", oldString: "secret", newString: "public" }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("rejects no-op edits", async () => {
    writeFileSync(join(workspace, "noop.txt"), "hello");

    const result = await tool.execute(
      makeCall({ path: "noop.txt", oldString: "hello", newString: "hello" }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("must be different");
  });
});

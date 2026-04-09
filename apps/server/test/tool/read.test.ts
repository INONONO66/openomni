import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@openomni/protocol";
import { createReadTool } from "../../src/tool/builtins/read";

const tmpRoot = join(import.meta.dir, ".tmp-read-tool");
const workspace = join(tmpRoot, "workspace");

function makeCall(input: Record<string, unknown>): Tool.Call {
  return { id: crypto.randomUUID(), tool: "read", input };
}

beforeAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(join(workspace, "dir-a"), { recursive: true });
  mkdirSync(join(workspace, "dir-b"), { recursive: true });
  writeFileSync(
    join(workspace, "story.txt"),
    Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
  );
  writeFileSync(join(workspace, "alpha.txt"), "alpha");
  writeFileSync(join(workspace, "zeta.txt"), "zeta");
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("createReadTool", () => {
  const tool = createReadTool(workspace);

  it("returns file content with 1-indexed line numbers", async () => {
    const result = await tool.execute(makeCall({ path: "story.txt" }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe(
      "1: line 1\n2: line 2\n3: line 3\n4: line 4\n5: line 5\n6: line 6\n7: line 7\n8: line 8\n9: line 9\n10: line 10\n11: line 11\n12: line 12\n13: line 13\n14: line 14\n15: line 15\n16: line 16\n17: line 17\n18: line 18\n19: line 19\n20: line 20",
    );
  });

  it("returns a sorted directory listing with directory suffixes", async () => {
    const result = await tool.execute(makeCall({ path: "." }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe("alpha.txt\ndir-a/\ndir-b/\nstory.txt\nzeta.txt");
  });

  it("blocks workspace escape attempts", async () => {
    const result = await tool.execute(makeCall({ path: "../../etc/passwd" }));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspace root");
  });

  it("applies offset and limit to file reads", async () => {
    const result = await tool.execute(makeCall({ path: "story.txt", offset: 5, limit: 10 }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe(
      "5: line 5\n6: line 6\n7: line 7\n8: line 8\n9: line 9\n10: line 10\n11: line 11\n12: line 12\n13: line 13\n14: line 14",
    );
  });
});

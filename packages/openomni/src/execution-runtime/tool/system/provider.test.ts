import { describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "@openomni/protocol";
import { SystemToolProvider } from "./provider.js";

function makeCall(tool: string): Tool.Call {
  return { id: "call-1", tool, input: {} };
}

let testDir: string;

async function setupTestDir(): Promise<void> {
  testDir = join(import.meta.dir, ".test-fixture");
  await mkdir(testDir, { recursive: true });
  // Create a small test file with predictable content
  await Bun.write(join(testDir, "test.txt"), "hello world\nfoo bar\n");
}

async function cleanupTestDir(): Promise<void> {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

describe("SystemToolProvider", () => {
  it("includes only bash when no workspaceRoot is provided", () => {
    const provider = new SystemToolProvider();
    const tools = provider.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0]?.spec.name).toBe("bash");
  });

  it("includes bash plus all filesystem tools when workspaceRoot is set", async () => {
    await setupTestDir();
    try {
      const provider = new SystemToolProvider(testDir);
      const tools = provider.listTools();

      expect(tools).toHaveLength(6);

      const names = tools.map((t) => t.spec.name);
      expect(names).toContain("bash");
      expect(names).toContain("read");
      expect(names).toContain("write");
      expect(names).toContain("edit");
      expect(names).toContain("grep.search");
      expect(names).toContain("glob");
    } finally {
      await cleanupTestDir();
    }
  });

  it("name and category metadata are correct", () => {
    const provider = new SystemToolProvider();

    expect(provider.name).toBe("system");
    expect(provider.category).toBe("system");
  });

  it("execute returns error for unknown tool", async () => {
    const provider = new SystemToolProvider();

    const result = await provider.execute(makeCall("nonexistent"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown tool: nonexistent");
  });

  it("execute routes underscore alias to the dotted tool name", async () => {
    await setupTestDir();
    try {
      const provider = new SystemToolProvider(testDir);

      const result = await provider.execute({
        id: "call-1",
        tool: "grep_search",
        input: { pattern: "hello", path: testDir },
      });

      expect(result.output).not.toContain("Unknown tool: grep_search");
    } finally {
      await cleanupTestDir();
    }
  });
});

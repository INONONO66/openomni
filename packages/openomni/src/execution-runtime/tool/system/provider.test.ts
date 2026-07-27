import { describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "@openomni/protocol";
import { createWorkspaceIdentity } from "../../workspace-identity.js";
import { SystemToolProvider } from "./provider.js";

function makeCall(tool: string): Tool.Call {
  return { id: "call-1", tool, input: {} };
}

let testDir: string;

async function setupTestDir(): Promise<void> {
  testDir = join(import.meta.dir, ".test-fixture");
  await mkdir(testDir, { recursive: true });
  await Bun.write(join(testDir, "test.txt"), "hello world\nfoo bar\n");
}

async function cleanupTestDir(): Promise<void> {
  await rm(testDir, { recursive: true, force: true });
}

describe("SystemToolProvider", () => {
  it("includes bash and all filesystem tools for the workspace identity", async () => {
    await setupTestDir();
    try {
      const provider = new SystemToolProvider(createWorkspaceIdentity(testDir));
      const tools = provider.listTools();

      expect(tools).toHaveLength(6);
      expect(tools.map((tool) => tool.spec.name)).toEqual([
        "bash",
        "read",
        "write",
        "edit",
        "grep.search",
        "glob",
      ]);
    } finally {
      await cleanupTestDir();
    }
  });

  it("exposes system provider metadata", async () => {
    await setupTestDir();
    try {
      const provider = new SystemToolProvider(createWorkspaceIdentity(testDir));
      expect(provider.name).toBe("system");
      expect(provider.category).toBe("system");
    } finally {
      await cleanupTestDir();
    }
  });

  it("returns an error for an unknown tool", async () => {
    await setupTestDir();
    try {
      const provider = new SystemToolProvider(createWorkspaceIdentity(testDir));
      const result = await provider.execute(makeCall("nonexistent"));

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Unknown tool: nonexistent");
    } finally {
      await cleanupTestDir();
    }
  });
});

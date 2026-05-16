import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@openomni/protocol";
import { createEditTool } from "./edit.js";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function withWorkspace(fn: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "openomni-edit-test-"));
  try {
    await fn(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function call(input: Record<string, unknown>): Tool.Call {
  return { id: "call-1", tool: "edit", input };
}

describe("createEditTool", () => {
  it("edits when expectedFileHash matches the current file", async () => {
    await withWorkspace(async (workspace) => {
      const target = join(workspace, "file.txt");
      const original = "hello world\n";
      await Bun.write(target, original);

      const tool = createEditTool(workspace);
      const result = await tool.execute(
        call({
          path: "file.txt",
          oldString: "world",
          newString: "openomni",
          expectedFileHash: await sha256Hex(original),
        }),
      );

      expect(result.isError).toBeUndefined();
      expect(await Bun.file(target).text()).toBe("hello openomni\n");
    });
  });

  it("rejects edits when expectedFileHash does not match", async () => {
    await withWorkspace(async (workspace) => {
      const target = join(workspace, "file.txt");
      const original = "hello world\n";
      await Bun.write(target, original);

      const tool = createEditTool(workspace);
      const result = await tool.execute(
        call({
          path: "file.txt",
          oldString: "world",
          newString: "openomni",
          expectedFileHash: await sha256Hex("stale content\n"),
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("File hash mismatch");
      expect(await Bun.file(target).text()).toBe(original);
    });
  });

  it("rejects malformed expectedFileHash values", async () => {
    await withWorkspace(async (workspace) => {
      const target = join(workspace, "file.txt");
      const original = "hello world\n";
      await Bun.write(target, original);

      const tool = createEditTool(workspace);
      const result = await tool.execute(
        call({
          path: "file.txt",
          oldString: "world",
          newString: "openomni",
          expectedFileHash: "not-a-sha256",
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("expectedFileHash must be a lowercase SHA-256 hex digest");
      expect(await Bun.file(target).text()).toBe(original);
    });
  });
});

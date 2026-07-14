import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolExecutor, WorkspaceLock } from "@openomni/openomni";
import type { Tool } from "@openomni/protocol";
import { McpToolProvider } from "../../../src/tool/mcp";
import { installStorageFixture, makeClient } from "./provider-test-fixture";

installStorageFixture();

describe("McpToolProvider", () => {
  it("does not start direct MCP execution when context is already aborted", async () => {
    const client = makeClient();
    client.listTools.mockResolvedValueOnce([
      { name: "search.query", description: "query", inputSchema: {} },
    ]);
    const provider = new McpToolProvider({ createClient: () => client.client });
    await provider.addServer({ name: "search", transport: "stdio", command: "search-mcp" });
    await provider.refreshTools();
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));

    try {
      await provider.execute(
        { id: "call-pre-abort", tool: "search.query", input: {} },
        { signal: controller.signal },
      );
      throw new Error("expected provider.execute to reject");
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      expect(error.message).toContain("MCP tool execution aborted");
    }
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("keeps direct MCP execution pending after abort until the underlying call settles", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "openomni-mcp-abort-lock-"));
    let settleCall: ((result: Tool.Result) => void) | undefined;
    const client = makeClient();
    client.listTools.mockResolvedValueOnce([
      { name: "search.query", description: "query", inputSchema: {} },
    ]);
    client.callTool.mockImplementation(
      async (toolName: string, _input: Record<string, unknown>, callId?: string) =>
        await new Promise<Tool.Result>((resolve) => {
          settleCall = () =>
            resolve({
              id: callId ?? crypto.randomUUID(),
              toolCallId: callId ?? "call",
              output: `${toolName} late`,
            });
        }),
    );
    const provider = new McpToolProvider({ createClient: () => client.client });

    try {
      await provider.addServer({ name: "search", transport: "stdio", command: "search-mcp" });
      await provider.refreshTools();
      const executor = createToolExecutor({
        tools: provider.listTools(),
        config: { workspaceRoot: workspace, timeoutMs: { tier1: 10 } },
      });

      const result = await executor({ id: "call-mcp", tool: "search.query", input: {} });
      expect(result.isError).toBe(true);
      expect(result.output).toBe("timeout after 10ms");

      const blockedProbe = await WorkspaceLock.acquire(workspace, "probe-before-settle", 30).catch(
        (error) => error,
      );
      expect(blockedProbe).toBeInstanceOf(Error);
      if (!(blockedProbe instanceof Error)) throw new Error("expected workspace lock error");
      expect(blockedProbe.message).toContain("workspace lock timeout");

      settleCall?.({ id: "late", toolCallId: "call-mcp", output: "late" });
      await Bun.sleep(0);

      await WorkspaceLock.acquire(workspace, "probe-after-settle", 50);
      WorkspaceLock.release(workspace, "probe-after-settle");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("marks the workspace unsafe after MCP abort settlement grace when the call hangs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "openomni-mcp-abort-grace-"));
    const client = makeClient();
    client.listTools.mockResolvedValueOnce([
      { name: "search.query", description: "query", inputSchema: {} },
    ]);
    client.callTool.mockImplementation(
      async () =>
        await new Promise<Tool.Result>(() => {
          // intentional: never resolves to exercise abort settlement grace
        }),
    );
    const provider = new McpToolProvider({ createClient: () => client.client });

    try {
      await provider.addServer({ name: "search", transport: "stdio", command: "search-mcp" });
      await provider.refreshTools();
      const executor = createToolExecutor({
        tools: provider.listTools(),
        config: {
          workspaceRoot: workspace,
          timeoutMs: { tier1: 10 },
          postTimeoutSettleGraceMs: 20,
        },
      });

      const result = await executor({ id: "call-mcp-hung", tool: "search.query", input: {} });
      expect(result.isError).toBe(true);
      expect(result.output).toBe("timeout after 10ms");

      const blockedProbe = await WorkspaceLock.acquire(workspace, "probe-before-grace", 5).catch(
        (error) => error,
      );
      expect(blockedProbe).toBeInstanceOf(Error);

      await Bun.sleep(40);
      const unsafeProbe = await WorkspaceLock.acquire(workspace, "probe-after-grace", 50).catch(
        (error) => error,
      );
      expect(unsafeProbe).toBeInstanceOf(Error);
      if (!(unsafeProbe instanceof Error)) throw new Error("expected unsafe workspace error");
      expect(unsafeProbe.message).toContain("workspace marked unsafe");
      WorkspaceLock.clearUnsafe(workspace);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

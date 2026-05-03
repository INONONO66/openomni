import { describe, expect, it, mock } from "bun:test";

import type { NativeTool } from "@openomni/openomni";
import type { Tool } from "@openomni/protocol";
import { McpPrefixGuardMiddleware, McpToolProvider } from "../../../src/tool/mcp";

function makeTool(name: string): { tool: NativeTool; execute: ReturnType<typeof mock> } {
  const execute = mock(
    async (call: Tool.Call): Promise<Tool.Result> => ({
      id: call.id,
      toolCallId: call.id,
      output: `${call.tool} ok`,
    }),
  );

  return {
    execute,
    tool: {
      spec: { name, description: `${name} tool`, inputSchema: {} },
      riskTier: 1,
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      source: "mcp",
      execute,
    },
  };
}

function seedProvider(
  provider: McpToolProvider,
  tools: readonly NativeTool[],
  connectedServers: readonly string[] = [],
): void {
  const clients = Reflect.get(provider, "clients");
  if (!(clients instanceof Map)) throw new Error("provider clients map not found");
  clients.clear();
  for (const serverName of connectedServers) {
    clients.set(serverName, {});
  }

  const connected = Reflect.get(provider, "connected");
  if (!(connected instanceof Set)) throw new Error("provider connected set not found");
  connected.clear();
  for (const serverName of connectedServers) {
    connected.add(serverName);
  }

  Reflect.set(provider, "cachedTools", [...tools]);
}

describe("McpToolProvider", () => {
  it("executes valid MCP-prefixed tools through the resolved canonical name", async () => {
    const provider = new McpToolProvider();
    const { tool, execute } = makeTool("search.query");
    seedProvider(provider, [tool], ["search"]);

    const result = await provider.execute({
      id: "call-1",
      tool: "search_query",
      input: { query: "hello" },
    });

    expect(result).toMatchObject({
      toolCallId: "call-1",
      output: "search.query ok",
    });
    expect(execute).toHaveBeenCalledWith({
      id: "call-1",
      tool: "search.query",
      input: { query: "hello" },
    });
  });

  it("preserves the unknown-tool error for unknown MCP prefixes", async () => {
    const provider = new McpToolProvider();
    const { tool } = makeTool("search.query");
    seedProvider(provider, [tool], ["search"]);

    const result = await provider.execute({ id: "call-2", tool: "ghost_query", input: {} });

    expect(result).toMatchObject({
      toolCallId: "call-2",
      output: "Unknown tool: ghost_query",
      isError: true,
    });
  });

  it("preserves the disconnected-server error for cached MCP tools", async () => {
    const provider = new McpToolProvider();
    const { tool, execute } = makeTool("search.query");
    seedProvider(provider, [tool]);

    const result = await provider.execute({ id: "call-3", tool: "search_query", input: {} });

    expect(result).toMatchObject({
      toolCallId: "call-3",
      output: "MCP server not found: search",
      isError: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves the missing-prefix error for MCP tools without server names", async () => {
    const provider = new McpToolProvider();
    const { tool, execute } = makeTool("query");
    seedProvider(provider, [tool], ["query"]);

    const result = await provider.execute({ id: "call-4", tool: "query", input: {} });

    expect(result).toMatchObject({
      toolCallId: "call-4",
      output: "MCP tool name must be prefixed with server name: query",
      isError: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("McpPrefixGuardMiddleware", () => {
  it("returns policy metadata on every verdict branch", async () => {
    const { tool: validTool } = makeTool("search.query");
    const { tool: unprefixedTool } = makeTool("query");
    const cases = [
      {
        call: { id: "call-a", tool: "search_query", input: {} },
        tools: [validTool],
        connected: true,
      },
      {
        call: { id: "call-b", tool: "ghost_query", input: {} },
        tools: [validTool],
        connected: true,
      },
      {
        call: { id: "call-c", tool: "search_query", input: {} },
        tools: [validTool],
        connected: false,
      },
      {
        call: { id: "call-d", tool: "query", input: {} },
        tools: [unprefixedTool],
        connected: true,
      },
    ] satisfies Array<{
      call: Tool.Call;
      tools: NativeTool[];
      connected: boolean;
    }>;

    for (const testCase of cases) {
      const result = await McpPrefixGuardMiddleware.evaluatePreToolUse({
        call: testCase.call,
        tools: testCase.tools,
        isServerConnected: () => testCase.connected,
      });

      expect(result.verdict.policyId).toBe("mcp.prefix-guard");
      expect(result.verdict.reason).toBeTruthy();
    }
  });
});

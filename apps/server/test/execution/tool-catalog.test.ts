import { describe, it, expect, mock } from "bun:test";

import { buildToolCatalog, resolveToolSelection } from "@openomni/openomni";
import { buildToolDispatcher } from "../../src/execution/coordinator";
import type { NativeTool, ToolExecutionContext, ToolProvider } from "@openomni/openomni";
import type { ToolSelection } from "@openomni/protocol";
import type { Tool } from "@openomni/protocol";

function makeTool(name: string, category?: ToolSelection.Category): NativeTool {
  return {
    spec: { name, description: `${name} tool`, inputSchema: {} },
    riskTier: 0,
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    category,
    execute: mock(async (call: Tool.Call, _context?: { signal?: AbortSignal }) => ({
      id: call.id,
      toolCallId: call.id,
      output: `${name} result`,
    })),
  };
}

function makeProvider(name: string, tools: NativeTool[]): ToolProvider {
  return {
    name,
    category: "system",
    listTools: () => tools,
    execute: mock(async (call: Tool.Call, _context?: { signal?: AbortSignal }) => ({
      id: call.id,
      toolCallId: call.id,
      output: `${name} result`,
    })),
  };
}

async function dispatchWithFallback(
  dispatcher: Map<string, (call: Tool.Call) => Promise<Tool.Result>>,
  call: Tool.Call,
): Promise<Tool.Result> {
  const handler = dispatcher.get(call.tool);
  if (!handler) {
    return {
      id: call.id,
      toolCallId: call.id,
      output: `Unknown tool: ${call.tool}`,
      isError: true,
    };
  }
  return handler(call);
}

describe("tool catalog", () => {
  it("buildToolCatalog with mixed sources produces flat catalog with resolved categories", () => {
    const systemTools = [
      makeTool("read"),
      makeTool("write"),
      makeTool("bash"),
      makeTool("glob"),
      makeTool("grep.search"),
    ];
    const mcpTools = [makeTool("mcp_tool")];
    const serverTools = [makeTool("server_analyzer", "filesystem")];

    const catalog = buildToolCatalog([
      { tools: systemTools, source: "system" },
      { tools: mcpTools, source: "mcp" },
      { tools: serverTools, source: "server" },
    ]);

    expect(catalog).toHaveLength(7);

    const byName = Object.fromEntries(catalog.map((e) => [e.canonicalName, e]));
    expect(byName.read?.category).toBe("filesystem");
    expect(byName.write?.category).toBe("filesystem");
    expect(byName.glob?.category).toBe("filesystem");
    expect(byName["grep.search"]?.category).toBe("filesystem");
    expect(byName.bash?.category).toBe("execution");
    expect(byName.mcp_tool?.category).toBe("mcp");
    expect(byName.server_analyzer?.category).toBe("filesystem");
  });

  it("resolveToolSelection with categories filters to matching tools only", () => {
    const tools = [
      makeTool("read"),
      makeTool("write"),
      makeTool("bash"),
      makeTool("dispatch"),
      makeTool("mcp_tool"),
    ];
    const catalog = buildToolCatalog([
      { tools: tools.slice(0, 4), source: "system" },
      { tools: tools.slice(4), source: "mcp" },
    ]);

    const selection: ToolSelection.Selection = { categories: ["filesystem", "execution"] };
    const result = resolveToolSelection(catalog, selection);

    const names = result.map((e) => e.canonicalName);
    expect(names.sort()).toEqual(["bash", "read", "write"]);
  });

  it("resolveToolSelection applies depth filtering to delegation and execution categories", () => {
    const tools = [makeTool("read"), makeTool("write"), makeTool("bash"), makeTool("dispatch")];
    const catalog = buildToolCatalog([{ tools, source: "system" }]);

    const selection: ToolSelection.Selection = {
      categories: ["filesystem", "execution", "delegation"],
    };

    const depth0 = resolveToolSelection(catalog, selection, undefined, 0);
    expect(depth0.map((e) => e.canonicalName).sort()).toEqual([
      "bash",
      "dispatch",
      "read",
      "write",
    ]);

    const depth1 = resolveToolSelection(catalog, selection, undefined, 1);
    expect(depth1.map((e) => e.canonicalName).sort()).toEqual(["bash", "read", "write"]);

    const depth2 = resolveToolSelection(catalog, selection, undefined, 2);
    expect(depth2.map((e) => e.canonicalName).sort()).toEqual(["read", "write"]);
  });

  it("MCP tool is dispatched through the provider that registered it", async () => {
    const mcpProvider = makeProvider("mock-mcp", [makeTool("mcp_tool")]);
    const dispatcher = buildToolDispatcher([mcpProvider]);

    const call: Tool.Call = { id: "call-1", tool: "mcp_tool", input: { query: "hello" } };
    await dispatchWithFallback(dispatcher, call);

    expect(mcpProvider.execute).toHaveBeenCalledTimes(1);
    expect(mcpProvider.execute).toHaveBeenCalledWith(call, undefined);
  });

  it("server-source fixture tool is dispatched through the server provider", async () => {
    const serverTool = makeTool("server_analyzer", "filesystem");
    const serverProvider = makeProvider("mock-server", [serverTool]);
    const dispatcher = buildToolDispatcher([serverProvider]);

    const call: Tool.Call = { id: "call-2", tool: "server_analyzer", input: { path: "/foo" } };
    await dispatchWithFallback(dispatcher, call);

    expect(serverProvider.execute).toHaveBeenCalledTimes(1);
    expect(serverProvider.execute).toHaveBeenCalledWith(call, undefined);
  });

  it("dispatcher forwards execution context to providers", async () => {
    const provider = makeProvider("mock-provider", [makeTool("known_tool")]);
    const dispatcher = buildToolDispatcher([provider]);
    const controller = new AbortController();
    const call: Tool.Call = { id: "call-ctx", tool: "known_tool", input: {} };
    const context = {
      signal: controller.signal,
      traceContext: {
        traceId: "trace-ctx",
        sessionId: "session-ctx",
        runId: "run-ctx",
      },
    } satisfies ToolExecutionContext;

    const result = await dispatcher.get("known_tool")?.(call, context);

    expect(result?.output).toBe("mock-provider result");
    expect(provider.execute).toHaveBeenCalledWith(call, context);
  });

  it("unknown tool name produces an isError result containing the tool name", async () => {
    const provider = makeProvider("mock-provider", [makeTool("known_tool")]);
    const dispatcher = buildToolDispatcher([provider]);

    const call: Tool.Call = { id: "call-3", tool: "does_not_exist", input: {} };
    const result = await dispatchWithFallback(dispatcher, call);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown tool:");
    expect(result.output).toContain("does_not_exist");
  });
});

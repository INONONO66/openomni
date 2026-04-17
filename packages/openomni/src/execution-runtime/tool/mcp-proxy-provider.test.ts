import { describe, expect, it, mock } from "bun:test";
import type { Tool } from "@openomni/protocol";
import type { WorkerBootstrap } from "@openomni/protocol";
import { McpProxyToolProvider } from "./mcp-proxy-provider.js";

type RuntimeToolCatalogEntry = WorkerBootstrap.RuntimeToolCatalogEntry;

function makeEntry(overrides?: Partial<RuntimeToolCatalogEntry>): RuntimeToolCatalogEntry {
  return {
    canonicalName: "filesystem.read_file",
    exposedName: "filesystem_read_file",
    source: "mcp",
    riskTier: 0,
    spec: {
      name: "filesystem.read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
    ...overrides,
  };
}

function makeCall(toolName: string, input: Record<string, unknown>): Tool.Call {
  return { id: crypto.randomUUID(), tool: toolName, input };
}

describe("McpProxyToolProvider", () => {
  it("listTools returns only mcp-sourced entries", () => {
    const systemEntry = makeEntry({ source: "system", canonicalName: "bash" });
    const mcpEntry = makeEntry();
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));

    const provider = McpProxyToolProvider.create([systemEntry, mcpEntry], callTool);
    const tools = provider.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0].spec.name).toBe("filesystem.read_file");
    expect(tools[0].source).toBe("mcp");
  });

  it("execute calls callTool with canonical name and input", async () => {
    const mockResult: Tool.Result = {
      id: crypto.randomUUID(),
      toolCallId: "call-1",
      output: "file content",
    };
    const callTool = mock(async (_name: string, _args: Record<string, unknown>) => mockResult);

    const provider = McpProxyToolProvider.create([makeEntry()], callTool);
    const [tool] = provider.listTools();

    const call = makeCall("filesystem.read_file", { path: "/tmp/test.txt" });
    const result = await tool.execute(call);

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("filesystem.read_file", { path: "/tmp/test.txt" });
    expect(result).toEqual(mockResult);
  });

  it("returns empty list when no mcp entries", () => {
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));
    const provider = McpProxyToolProvider.create([], callTool);
    expect(provider.listTools()).toHaveLength(0);
  });

  it("each tool delegates to the correct canonical name", async () => {
    const entryA = makeEntry({
      canonicalName: "server-a.tool_one",
      spec: { name: "server-a.tool_one", description: "Tool one", inputSchema: {} },
    });
    const entryB = makeEntry({
      canonicalName: "server-b.tool_two",
      spec: { name: "server-b.tool_two", description: "Tool two", inputSchema: {} },
    });
    const callTool = mock(async (name: string) => ({
      id: crypto.randomUUID(),
      toolCallId: "c",
      output: name,
    }));

    const provider = McpProxyToolProvider.create([entryA, entryB], callTool);
    const [toolA, toolB] = provider.listTools();

    await toolA.execute(makeCall("server-a.tool_one", {}));
    await toolB.execute(makeCall("server-b.tool_two", {}));

    expect(callTool.mock.calls[0][0]).toBe("server-a.tool_one");
    expect(callTool.mock.calls[1][0]).toBe("server-b.tool_two");
  });
});

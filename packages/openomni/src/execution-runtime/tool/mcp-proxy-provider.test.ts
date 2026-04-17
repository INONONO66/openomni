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

  it("filters out non-mcp entries (source=system)", () => {
    const systemEntry = makeEntry({ source: "system", canonicalName: "bash" });
    const agentEntry = makeEntry({ source: "agent", canonicalName: "subagent" });
    const mcpEntry = makeEntry({
      source: "mcp",
      canonicalName: "filesystem.read",
      spec: { name: "filesystem.read", description: "Read file", inputSchema: {} },
    });
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));

    const provider = McpProxyToolProvider.create([systemEntry, agentEntry, mcpEntry], callTool);
    const tools = provider.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0].spec.name).toBe("filesystem.read");
  });

  it("execute returns exact result from callTool without mutation", async () => {
    const mockResult: Tool.Result = {
      id: crypto.randomUUID(),
      toolCallId: "call-123",
      output: "exact output",
      isError: false,
    };
    const callTool = mock(async () => mockResult);

    const provider = McpProxyToolProvider.create([makeEntry()], callTool);
    const [tool] = provider.listTools();

    const result = await tool.execute(makeCall("filesystem.read_file", { path: "/test" }));

    expect(result).toBe(mockResult);
    expect(result.output).toBe("exact output");
    expect(result.isError).toBe(false);
  });

  it("multiple mcp entries all become tools", () => {
    const entries = [
      makeEntry({
        canonicalName: "fs.read",
        spec: { name: "fs.read", description: "Read", inputSchema: {} },
      }),
      makeEntry({
        canonicalName: "fs.write",
        spec: { name: "fs.write", description: "Write", inputSchema: {} },
      }),
      makeEntry({
        canonicalName: "fs.delete",
        spec: { name: "fs.delete", description: "Delete", inputSchema: {} },
      }),
    ];
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));

    const provider = McpProxyToolProvider.create(entries, callTool);
    const tools = provider.listTools();

    expect(tools).toHaveLength(3);
    expect(tools[0].spec.name).toBe("fs.read");
    expect(tools[1].spec.name).toBe("fs.write");
    expect(tools[2].spec.name).toBe("fs.delete");
  });

  it("tool spec is preserved exactly from entry", () => {
    const spec = {
      name: "custom.tool",
      description: "A custom tool with complex schema",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean" },
          timeout: { type: "number" },
        },
        required: ["path"],
      },
    };
    const entry = makeEntry({ spec });
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));

    const provider = McpProxyToolProvider.create([entry], callTool);
    const [tool] = provider.listTools();

    expect(tool.spec).toEqual(spec);
    expect(tool.spec.name).toBe("custom.tool");
    expect(tool.spec.inputSchema).toEqual(spec.inputSchema);
  });

  it("riskTier is preserved from entry", () => {
    const entries = [
      makeEntry({ riskTier: 0 }),
      makeEntry({ riskTier: 1, canonicalName: "medium.risk" }),
      makeEntry({ riskTier: 2, canonicalName: "high.risk" }),
    ];
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));

    const provider = McpProxyToolProvider.create(entries, callTool);
    const tools = provider.listTools();

    expect(tools[0].riskTier).toBe(0);
    expect(tools[1].riskTier).toBe(1);
    expect(tools[2].riskTier).toBe(2);
  });

  it("isReadOnly, isDestructive, isConcurrencySafe are hardcoded false", () => {
    const entry = makeEntry();
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));

    const provider = McpProxyToolProvider.create([entry], callTool);
    const [tool] = provider.listTools();

    expect(tool.isReadOnly).toBe(false);
    expect(tool.isDestructive).toBe(false);
    expect(tool.isConcurrencySafe).toBe(false);
  });
});

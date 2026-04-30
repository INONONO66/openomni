import { describe, expect, it, mock } from "bun:test";
import type { Tool } from "@openomni/protocol";
import type { WorkerBootstrap } from "@openomni/protocol";
import { ToolProxyProvider } from "./tool-proxy-provider.js";

type RuntimeToolCatalogEntry = WorkerBootstrap.RuntimeToolCatalogEntry;

function makeEntry(overrides?: Partial<RuntimeToolCatalogEntry>): RuntimeToolCatalogEntry {
  return {
    canonicalName: "filesystem.read_file",
    exposedName: "filesystem_read_file",
    source: "mcp",
    category: "mcp",
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

function getTool(
  tools: ReturnType<ReturnType<typeof ToolProxyProvider.create>["listTools"]>,
  index: number,
) {
  const tool = tools[index];
  if (tool == null) {
    throw new Error(`expected tool at index ${index}`);
  }
  return tool;
}

describe("ToolProxyProvider", () => {
  it("listTools returns all entries regardless of source", () => {
    const systemEntry = makeEntry({
      source: "system",
      canonicalName: "bash",
      spec: { name: "bash", description: "Run bash", inputSchema: {} },
    });
    const mcpEntry = makeEntry();
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));

    const provider = ToolProxyProvider.create([systemEntry, mcpEntry], callTool);
    const tools = provider.listTools();

    expect(tools).toHaveLength(2);
    expect(getTool(tools, 0).spec.name).toBe("bash");
    expect(getTool(tools, 0).source).toBe("system");
    expect(getTool(tools, 1).spec.name).toBe("filesystem.read_file");
    expect(getTool(tools, 1).source).toBe("mcp");
  });

  it("execute calls callTool with canonical name and input", async () => {
    const mockResult: Tool.Result = {
      id: crypto.randomUUID(),
      toolCallId: "call-1",
      output: "file content",
    };
    const callTool = mock(async (_name: string, _args: Record<string, unknown>) => mockResult);

    const provider = ToolProxyProvider.create([makeEntry()], callTool);
    const tool = getTool(provider.listTools(), 0);

    const call = makeCall("filesystem.read_file", { path: "/tmp/test.txt" });
    const result = await tool.execute(call);

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("filesystem.read_file", { path: "/tmp/test.txt" });
    expect(result).toEqual(mockResult);
  });

  it("returns empty list when no entries", () => {
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));
    const provider = ToolProxyProvider.create([], callTool);
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

    const provider = ToolProxyProvider.create([entryA, entryB], callTool);
    const tools = provider.listTools();
    const toolA = getTool(tools, 0);
    const toolB = getTool(tools, 1);

    await toolA.execute(makeCall("server-a.tool_one", {}));
    await toolB.execute(makeCall("server-b.tool_two", {}));

    expect(callTool.mock.calls[0]?.[0]).toBe("server-a.tool_one");
    expect(callTool.mock.calls[1]?.[0]).toBe("server-b.tool_two");
  });

  it("proxies all entries regardless of source", () => {
    const systemEntry = makeEntry({
      source: "system",
      canonicalName: "bash",
      spec: { name: "bash", description: "Run bash", inputSchema: {} },
    });
    const agentEntry = makeEntry({
      source: "agent",
      canonicalName: "subagent",
      spec: { name: "subagent", description: "Subagent", inputSchema: {} },
    });
    const mcpEntry = makeEntry({
      source: "mcp",
      canonicalName: "filesystem.read",
      spec: { name: "filesystem.read", description: "Read file", inputSchema: {} },
    });
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));

    const provider = ToolProxyProvider.create([systemEntry, agentEntry, mcpEntry], callTool);
    const tools = provider.listTools();

    expect(tools).toHaveLength(3);
    expect(getTool(tools, 0).spec.name).toBe("bash");
    expect(getTool(tools, 0).source).toBe("system");
    expect(getTool(tools, 1).spec.name).toBe("subagent");
    expect(getTool(tools, 1).source).toBe("agent");
    expect(getTool(tools, 2).spec.name).toBe("filesystem.read");
    expect(getTool(tools, 2).source).toBe("mcp");
  });

  it("execute returns exact result from callTool without mutation", async () => {
    const mockResult: Tool.Result = {
      id: crypto.randomUUID(),
      toolCallId: "call-123",
      output: "exact output",
      isError: false,
    };
    const callTool = mock(async () => mockResult);

    const provider = ToolProxyProvider.create([makeEntry()], callTool);
    const tool = getTool(provider.listTools(), 0);

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

    const provider = ToolProxyProvider.create(entries, callTool);
    const tools = provider.listTools();

    expect(tools).toHaveLength(3);
    expect(getTool(tools, 0).spec.name).toBe("fs.read");
    expect(getTool(tools, 1).spec.name).toBe("fs.write");
    expect(getTool(tools, 2).spec.name).toBe("fs.delete");
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

    const provider = ToolProxyProvider.create([entry], callTool);
    const tool = getTool(provider.listTools(), 0);

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

    const provider = ToolProxyProvider.create(entries, callTool);
    const tools = provider.listTools();

    expect(getTool(tools, 0).riskTier).toBe(0);
    expect(getTool(tools, 1).riskTier).toBe(1);
    expect(getTool(tools, 2).riskTier).toBe(2);
  });

  it("isReadOnly, isDestructive, isConcurrencySafe are hardcoded false", () => {
    const entry = makeEntry();
    const callTool = mock(async () => ({ id: "r1", toolCallId: "c1", output: "" }));

    const provider = ToolProxyProvider.create([entry], callTool);
    const tool = getTool(provider.listTools(), 0);

    expect(tool.isReadOnly).toBe(false);
    expect(tool.isDestructive).toBe(false);
    expect(tool.isConcurrencySafe).toBe(false);
  });
});

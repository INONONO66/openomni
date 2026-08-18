import { describe, expect, it } from "bun:test";
import type { Policy, Tool, WorkerBootstrap } from "@openomni/protocol";
import {
  createMcpProxyProvider,
  type WorkerRunIpcServer,
} from "../../src/execution/worker-runner-ipc";

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

interface RecordedCall {
  method: string;
  params?: Record<string, unknown>;
}

function makeServer(result?: Tool.Result): { server: WorkerRunIpcServer; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const server: WorkerRunIpcServer = {
    call: (method, params) => {
      calls.push({ method, ...(params !== undefined && { params }) });
      return Promise.resolve(result ?? { id: "r1", toolCallId: "c1", output: "" });
    },
    notify: () => undefined,
  };
  return { server, calls };
}

function makeProvider(
  entries: RuntimeToolCatalogEntry[],
  result?: Tool.Result,
): {
  tools: ReturnType<ReturnType<typeof createMcpProxyProvider>["listTools"]>;
  calls: RecordedCall[];
} {
  const { server, calls } = makeServer(result);
  const provider = createMcpProxyProvider({
    toolCatalog: entries,
    server,
    ipcAuthToken: "test-ipc-token",
    runId: "run-1",
    sessionId: "session-1",
  });
  return { tools: provider.listTools(), calls };
}

function getTool<T>(tools: readonly T[], index: number): T {
  const tool = tools[index];
  if (tool == null) {
    throw new Error(`expected tool at index ${index}`);
  }
  return tool;
}

describe("createMcpProxyProvider", () => {
  it("listTools returns all entries regardless of source", () => {
    const systemEntry = makeEntry({
      source: "system",
      canonicalName: "bash",
      spec: { name: "bash", description: "Run bash", inputSchema: {} },
    });
    const { tools } = makeProvider([systemEntry, makeEntry()]);

    expect(tools).toHaveLength(2);
    expect(getTool(tools, 0).spec.name).toBe("bash");
    expect(getTool(tools, 0).source).toBe("system");
    expect(getTool(tools, 1).spec.name).toBe("filesystem.read_file");
    expect(getTool(tools, 1).source).toBe("mcp");
  });

  it("execute sends worker.tool_call with canonical name and input", async () => {
    const mockResult: Tool.Result = {
      id: crypto.randomUUID(),
      toolCallId: "call-1",
      output: "file content",
    };
    const { tools, calls } = makeProvider([makeEntry()], mockResult);
    const tool = getTool(tools, 0);

    const result = await tool.execute(makeCall("filesystem.read_file", { path: "/tmp/test.txt" }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("worker.tool_call");
    expect(calls[0]?.params).toMatchObject({
      authToken: "test-ipc-token",
      tool: "filesystem.read_file",
      input: { path: "/tmp/test.txt" },
      runId: "run-1",
      sessionId: "session-1",
    });
    expect(result).toEqual(mockResult);
  });

  it("execute short-circuits on a pre-aborted execution context", async () => {
    const controller = new AbortController();
    controller.abort();
    const { tools, calls } = makeProvider([makeEntry()]);
    const tool = getTool(tools, 0);

    const result = await tool.execute(makeCall("filesystem.read_file", { path: "/tmp/test.txt" }), {
      signal: controller.signal,
    });

    expect(calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("Tool call aborted");
  });

  it("returns empty list when no entries", () => {
    const { tools } = makeProvider([]);
    expect(tools).toHaveLength(0);
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
    const { tools, calls } = makeProvider([entryA, entryB]);

    await getTool(tools, 0).execute(makeCall("server-a.tool_one", {}));
    await getTool(tools, 1).execute(makeCall("server-b.tool_two", {}));

    expect(calls[0]?.params?.tool).toBe("server-a.tool_one");
    expect(calls[1]?.params?.tool).toBe("server-b.tool_two");
  });

  it("proxies all entries regardless of source", () => {
    const systemEntry = makeEntry({
      source: "system",
      canonicalName: "bash",
      spec: { name: "bash", description: "Run bash", inputSchema: {} },
    });
    const agentEntry = makeEntry({
      source: "agent",
      canonicalName: "dispatch",
      spec: { name: "dispatch", description: "Command", inputSchema: {} },
    });
    const mcpEntry = makeEntry({
      source: "mcp",
      canonicalName: "filesystem.read",
      spec: { name: "filesystem.read", description: "Read file", inputSchema: {} },
    });
    const { tools } = makeProvider([systemEntry, agentEntry, mcpEntry]);

    expect(tools).toHaveLength(3);
    expect(getTool(tools, 0).source).toBe("system");
    expect(getTool(tools, 1).source).toBe("agent");
    expect(getTool(tools, 2).source).toBe("mcp");
  });

  it("execute returns the parsed IPC result unchanged", async () => {
    const mockResult: Tool.Result = {
      id: crypto.randomUUID(),
      toolCallId: "call-123",
      output: "exact output",
      isError: false,
    };
    const { tools } = makeProvider([makeEntry()], mockResult);

    const result = await getTool(tools, 0).execute(
      makeCall("filesystem.read_file", { path: "/test" }),
    );

    expect(result).toEqual(mockResult);
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
    const { tools } = makeProvider(entries);

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
    const { tools } = makeProvider([makeEntry({ spec })]);
    const tool = getTool(tools, 0);

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
    const { tools } = makeProvider(entries);

    expect(getTool(tools, 0).riskTier).toBe(0);
    expect(getTool(tools, 1).riskTier).toBe(1);
    expect(getTool(tools, 2).riskTier).toBe(2);
  });

  it("isReadOnly, isDestructive, isConcurrencySafe are hardcoded false", () => {
    const { tools } = makeProvider([makeEntry()]);
    const tool = getTool(tools, 0);

    expect(tool.isReadOnly).toBe(false);
    expect(tool.isDestructive).toBe(false);
    expect(tool.isConcurrencySafe).toBe(false);
  });

  it("preserves descriptors when proxying worker tools", () => {
    const descriptor: Policy.Resource.Descriptor = {
      id: "tool:server:remote.echo",
      kind: "tool",
      source: { type: "server" },
      labels: ["tool:remote.echo", "risk:tier-1"],
      capabilities: ["write"],
      effects: [],
      risk: 1,
    };
    const entry: RuntimeToolCatalogEntry = {
      canonicalName: "remote.echo",
      exposedName: "remote_echo",
      source: "server",
      category: "custom",
      riskTier: 1,
      spec: {
        name: "remote.echo",
        inputSchema: { type: "object", properties: {} },
        labels: descriptor.labels,
      },
      descriptor,
    };
    const { tools } = makeProvider([entry]);

    expect(getTool(tools, 0)?.descriptor).toBe(descriptor);
  });
});

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { NativeTool } from "@openomni/openomni";
import type { Tool } from "@openomni/protocol";
import { Mcp } from "@openomni/protocol";
import { Bus, Session, Storage } from "@openomni/session";
import { McpPrefixGuardMiddleware, McpToolProvider } from "../../../src/tool/mcp";

beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

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

function makeClient() {
  const connect = mock(async (): Promise<void> => undefined);
  const disconnect = mock(async (): Promise<void> => undefined);
  const listTools = mock(async (): Promise<Tool.Spec[]> => []);
  const callTool = mock(
    async (
      toolName: string,
      _input: Record<string, unknown>,
      callId?: string,
    ): Promise<Tool.Result> => ({
      id: callId ?? crypto.randomUUID(),
      toolCallId: callId ?? "call",
      output: `${toolName} ok`,
    }),
  );

  return {
    client: { connect, disconnect, listTools, callTool },
    connect,
    disconnect,
    listTools,
    callTool,
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

function createLedgerSession(): Session.Info {
  return Session.create({
    title: "mcp-ledger-test",
    model: { providerID: "test", modelID: "test-model" },
  });
}

function collectBusEvents(): {
  events: Array<{ name: string; payload: Record<string, unknown> }>;
  stop: () => void;
} {
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const unsubscribe = Bus.observe((descriptor, payload) => {
    events.push({ name: descriptor.name, payload: payload as Record<string, unknown> });
  });
  return { events, stop: unsubscribe };
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

  it("emits Mcp.ToolCompleted event on successful tool execution", async () => {
    const provider = new McpToolProvider();
    const { tool } = makeTool("search.query");
    seedProvider(provider, [tool], ["search"]);

    const publishedEvents: Array<{ name: string; payload: unknown }> = [];
    const unsubscribe = Bus.subscribe(Mcp.ToolCompleted, (payload) => {
      publishedEvents.push({ name: "mcp.tool.completed", payload });
    });

    try {
      const result = await provider.execute({
        id: "call-success",
        tool: "search_query",
        input: { query: "test" },
      });

      expect(result.isError).toBeFalsy();
      expect(publishedEvents).toHaveLength(1);
      const event = publishedEvents[0].payload as Record<string, unknown>;
      expect(event.toolCallId).toBe("call-success");
      expect(event.toolName).toBe("search.query");
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.resultSummary).toContain("success");
    } finally {
      unsubscribe();
    }
  });

  it("does not emit Mcp.ToolCompleted on guard-denied execution", async () => {
    const provider = new McpToolProvider();
    const { tool } = makeTool("search.query");
    seedProvider(provider, [tool], ["search"]);

    const publishedEvents: Array<{ name: string; payload: unknown }> = [];
    const unsubscribe = Bus.subscribe(Mcp.ToolCompleted, (payload) => {
      publishedEvents.push({ name: "mcp.tool.completed", payload });
    });

    try {
      const result = await provider.execute({
        id: "call-denied",
        tool: "ghost_query",
        input: {},
      });

      expect(result.isError).toBeTruthy();
      expect(publishedEvents).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it("does not emit Mcp.ToolCompleted on error result", async () => {
    const provider = new McpToolProvider();
    const execute = mock(
      async (call: Tool.Call): Promise<Tool.Result> => ({
        id: call.id,
        toolCallId: call.id,
        output: "Tool execution failed",
        isError: true,
      }),
    );

    const tool: NativeTool = {
      spec: { name: "search.query", description: "search tool", inputSchema: {} },
      riskTier: 1,
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      source: "mcp",
      execute,
    };

    seedProvider(provider, [tool], ["search"]);

    const publishedEvents: Array<{ name: string; payload: unknown }> = [];
    const unsubscribe = Bus.subscribe(Mcp.ToolCompleted, (payload) => {
      publishedEvents.push({ name: "mcp.tool.completed", payload });
    });

    try {
      const result = await provider.execute({
        id: "call-error",
        tool: "search_query",
        input: {},
      });

      expect(result.isError).toBeTruthy();
      expect(publishedEvents).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it("publishes policy and completion events for successful MCP dispatch", async () => {
    const provider = new McpToolProvider();
    const session = createLedgerSession();
    const { tool } = makeTool("search.query");
    seedProvider(provider, [tool], ["search"]);

    const { events, stop } = collectBusEvents();

    try {
      const result = await provider.execute({
        id: "call-bus-success",
        tool: "search_query",
        input: { sessionId: session.id, query: "bus" },
      });

      expect(result.isError).toBeFalsy();
      const policyAndToolEvents = events.filter(
        (e) => e.name === "policy.action.requested" || e.name === "tool.execution.completed",
      );
      expect(policyAndToolEvents.map((e) => e.name)).toEqual([
        "policy.action.requested",
        "tool.execution.completed",
      ]);
      expect(policyAndToolEvents[0].payload).toMatchObject({
        action: "mcp.tool.call",
        resource: "search.query",
      });
      expect(policyAndToolEvents[1].payload).toMatchObject({
        toolCallId: "call-bus-success",
        isError: false,
      });
    } finally {
      stop();
    }
  });

  it("publishes completion events for error results without Mcp.ToolCompleted", async () => {
    const provider = new McpToolProvider();
    const session = createLedgerSession();
    const execute = mock(
      async (call: Tool.Call): Promise<Tool.Result> => ({
        id: call.id,
        toolCallId: call.id,
        output: "Tool execution failed",
        isError: true,
      }),
    );
    const tool: NativeTool = {
      spec: { name: "search.query", description: "search tool", inputSchema: {} },
      riskTier: 1,
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      source: "mcp",
      execute,
    };
    seedProvider(provider, [tool], ["search"]);

    const { events, stop } = collectBusEvents();

    try {
      const result = await provider.execute({
        id: "call-bus-error",
        tool: "search_query",
        input: { sessionId: session.id },
      });

      expect(result.isError).toBeTruthy();
      const mcpCompleted = events.find((e) => e.name === "mcp.tool.completed");
      expect(mcpCompleted).toBeUndefined();
      const toolCompleted = events.find((e) => e.name === "tool.execution.completed");
      expect(toolCompleted?.payload).toMatchObject({
        toolCallId: "call-bus-error",
        isError: true,
      });
    } finally {
      stop();
    }
  });

  it("publishes action_blocked events for guarded MCP execution failures", async () => {
    const provider = new McpToolProvider();
    const unknownSession = createLedgerSession();
    const disconnectedSession = createLedgerSession();
    const unprefixedSession = createLedgerSession();
    const { tool, execute } = makeTool("search.query");
    const { tool: unprefixedTool } = makeTool("query");

    const allEvents: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = Bus.observe((descriptor, payload) => {
      allEvents.push({ name: descriptor.name, payload: payload as Record<string, unknown> });
    });

    try {
      seedProvider(provider, [tool], ["search"]);
      await provider.execute({
        id: "call-unknown",
        tool: "ghost_query",
        input: { sessionId: unknownSession.id },
      });

      seedProvider(provider, [tool]);
      await provider.execute({
        id: "call-disconnected",
        tool: "search_query",
        input: { sessionId: disconnectedSession.id },
      });

      seedProvider(provider, [unprefixedTool], ["query"]);
      await provider.execute({
        id: "call-unprefixed",
        tool: "query",
        input: { sessionId: unprefixedSession.id },
      });

      const blockedEvents = allEvents.filter((e) => e.name === "policy.action.blocked");
      expect(blockedEvents).toHaveLength(3);
      expect(blockedEvents[0].payload).toMatchObject({
        resource: "ghost_query",
        reason: "Unknown tool: ghost_query",
      });
      expect(blockedEvents[1].payload).toMatchObject({
        resource: "search.query",
        reason: "MCP server not found: search",
      });
      expect(blockedEvents[2].payload).toMatchObject({
        resource: "query",
        reason: "MCP tool name must be prefixed with server name: query",
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("publishes connect lifecycle events when an audit session is provided", async () => {
    const session = createLedgerSession();
    const client = makeClient();
    const provider = new McpToolProvider({ createClient: () => client.client });

    const { events, stop } = collectBusEvents();

    try {
      await provider.addServer(
        {
          name: "search",
          transport: "stdio",
          command: "search-mcp",
          args: ["--stdio"],
          headers: { Authorization: "redacted" },
        },
        { audit: { sessionId: session.id }, actor: { operator: "test" } },
      );

      expect(client.connect).toHaveBeenCalled();
      const lifecycleEvents = events.filter(
        (e) => e.name === "policy.action.requested" || e.name === "policy.action.approved",
      );
      expect(lifecycleEvents.map((e) => e.name)).toEqual([
        "policy.action.requested",
        "policy.action.approved",
      ]);
      expect(lifecycleEvents[0].payload).toMatchObject({
        action: "mcp.server.connect",
        resource: "search",
        actor: { kind: "mcp_provider", sessionId: session.id, operator: "test" },
        context: {
          serverName: "search",
          transport: "stdio",
          command: "search-mcp",
          argsCount: 1,
          headerNames: ["Authorization"],
        },
      });
      expect(lifecycleEvents[1].payload).toMatchObject({
        action: "mcp.server.connect",
        resource: "search",
        verdict: "continue",
        reason: "MCP server connected",
      });
      expect(lifecycleEvents[0].payload.actionId).toBe(lifecycleEvents[1].payload.actionId);
    } finally {
      stop();
    }
  });

  it("publishes remove lifecycle events when an audit session is provided", async () => {
    const session = createLedgerSession();
    const client = makeClient();
    const provider = new McpToolProvider({ createClient: () => client.client });
    await provider.addServer({ name: "search", transport: "stdio", command: "search-mcp" });

    const { events, stop } = collectBusEvents();

    try {
      await provider.removeServer("search", { audit: { sessionId: session.id } });

      expect(client.disconnect).toHaveBeenCalled();
      expect(provider.serverCount).toBe(0);
      const lifecycleEvents = events.filter(
        (e) => e.name === "policy.action.requested" || e.name === "policy.action.approved",
      );
      expect(lifecycleEvents.map((e) => e.name)).toEqual([
        "policy.action.requested",
        "policy.action.approved",
      ]);
      expect(lifecycleEvents[0].payload).toMatchObject({
        action: "mcp.server.disconnect",
        resource: "search",
        context: { serverName: "search" },
      });
      expect(lifecycleEvents[1].payload).toMatchObject({
        action: "mcp.server.disconnect",
        resource: "search",
        verdict: "continue",
      });
      expect(lifecycleEvents[0].payload.actionId).toBe(lifecycleEvents[1].payload.actionId);
    } finally {
      stop();
    }
  });

  it("publishes disconnectAll lifecycle events when an audit session is provided", async () => {
    const session = createLedgerSession();
    const searchClient = makeClient();
    const memoryClient = makeClient();
    const clients = new Map([
      ["search", searchClient.client],
      ["memory", memoryClient.client],
    ]);
    const provider = new McpToolProvider({
      createClient: (config) => {
        const client = clients.get(config.name);
        if (!client) throw new Error(`missing client for ${config.name}`);
        return client;
      },
    });
    await provider.addServer({ name: "search", transport: "stdio", command: "search-mcp" });
    await provider.addServer({ name: "memory", transport: "stdio", command: "memory-mcp" });

    const { events, stop } = collectBusEvents();

    try {
      await provider.disconnectAll({ audit: { sessionId: session.id } });

      expect(searchClient.disconnect).toHaveBeenCalled();
      expect(memoryClient.disconnect).toHaveBeenCalled();
      expect(provider.serverCount).toBe(0);
      const lifecycleEvents = events.filter(
        (e) => e.name === "policy.action.requested" || e.name === "policy.action.approved",
      );
      expect(lifecycleEvents.map((e) => e.name)).toEqual([
        "policy.action.requested",
        "policy.action.approved",
      ]);
      expect(lifecycleEvents[0].payload).toMatchObject({
        action: "mcp.server.disconnect_all",
        resource: "mcp.servers",
        context: { serverNames: ["search", "memory"] },
      });
      expect(lifecycleEvents[1].payload).toMatchObject({
        action: "mcp.server.disconnect_all",
        resource: "mcp.servers",
        verdict: "continue",
      });
      expect(lifecycleEvents[0].payload.actionId).toBe(lifecycleEvents[1].payload.actionId);
    } finally {
      stop();
    }
  });

  it("uses the latest session as default lifecycle audit context", async () => {
    createLedgerSession();
    const client = makeClient();
    const provider = new McpToolProvider({ createClient: () => client.client });

    const { events, stop } = collectBusEvents();

    try {
      await provider.addServer({ name: "search", transport: "stdio", command: "search-mcp" });
      await provider.removeServer("search");

      expect(client.connect).toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalled();
      const lifecycleEvents = events.filter(
        (e) => e.name === "policy.action.requested" || e.name === "policy.action.approved",
      );
      expect(lifecycleEvents.map((e) => e.name)).toEqual([
        "policy.action.requested",
        "policy.action.approved",
        "policy.action.requested",
        "policy.action.approved",
      ]);
    } finally {
      stop();
    }
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

      expect(result.verdict.policyId).toBe("guardrail.permission");
      expect(result.verdict.reason).toBeTruthy();
    }
  });
});

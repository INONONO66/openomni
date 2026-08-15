import { describe, expect, it, mock } from "bun:test";

import type { NativeTool } from "@openomni/openomni";
import type { Tool } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { McpToolProvider } from "../../../src/tool/mcp";
import {
  TEST_BOOT_TRACE_ID,
  collectBusEvents,
  createLedgerSession,
  executionContext,
  installStorageFixture,
  makeTool,
  seedProvider,
  toRecord,
} from "./provider-test-fixture";

installStorageFixture();

describe("McpToolProvider", () => {
  it("publishes policy and completion events for successful MCP dispatch", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    const session = createLedgerSession();
    const { tool } = makeTool("search.query");
    seedProvider(provider, [tool], ["search"]);

    const { events, stop } = collectBusEvents();

    try {
      const result = await provider.execute(
        {
          id: "call-bus-success",
          tool: "search_query",
          input: { sessionId: session.id, query: "bus" },
        },
        executionContext(),
      );

      expect(result.isError).toBeFalsy();
      // #522 defect 2: this layer keeps authorization audit and MCP-domain
      // events only; ToolExecution.Completed comes solely from the
      // worker-side executor dispatching these tools.
      const auditEvents = events.filter(
        (event) =>
          event.name === "policy.action.requested" ||
          event.name === "tool.execution.completed" ||
          event.name === "mcp.tool.completed",
      );
      expect(auditEvents.map((event) => event.name)).toEqual([
        "policy.action.requested",
        "mcp.tool.completed",
      ]);
      expect(auditEvents[0]?.payload).toMatchObject({
        action: "mcp.tool.call",
        resource: "search.query",
      });
      expect(auditEvents[1]?.payload).toMatchObject({
        toolCallId: "call-bus-success",
      });
    } finally {
      stop();
    }
  });

  it("publishes no completion events for error results", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
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
      const result = await provider.execute(
        {
          id: "call-bus-error",
          tool: "search_query",
          input: { sessionId: session.id },
        },
        executionContext(),
      );

      expect(result.isError).toBeTruthy();
      const mcpCompleted = events.find((event) => event.name === "mcp.tool.completed");
      expect(mcpCompleted).toBeUndefined();
      // #522 defect 2: no provider-layer ToolExecution.Completed — the
      // worker-side executor is the sole emitter.
      const toolCompleted = events.find((event) => event.name === "tool.execution.completed");
      expect(toolCompleted).toBeUndefined();
    } finally {
      stop();
    }
  });

  it("publishes action_blocked events for guarded MCP execution failures", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    const unknownSession = createLedgerSession();
    const disconnectedSession = createLedgerSession();
    const unprefixedSession = createLedgerSession();
    const { tool, execute } = makeTool("search.query");
    const { tool: unprefixedTool } = makeTool("query");

    const allEvents: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = Bus.observe((descriptor, payload) => {
      allEvents.push({ name: descriptor.name, payload: toRecord(payload) });
    });

    try {
      seedProvider(provider, [tool], ["search"]);
      await provider.execute(
        {
          id: "call-unknown",
          tool: "ghost_query",
          input: { sessionId: unknownSession.id },
        },
        executionContext(),
      );

      seedProvider(provider, [tool]);
      await provider.execute(
        {
          id: "call-disconnected",
          tool: "search_query",
          input: { sessionId: disconnectedSession.id },
        },
        executionContext(),
      );

      seedProvider(provider, [unprefixedTool], ["query"]);
      await provider.execute(
        {
          id: "call-unprefixed",
          tool: "query",
          input: { sessionId: unprefixedSession.id },
        },
        executionContext(),
      );

      const blockedEvents = allEvents.filter((event) => event.name === "policy.action.blocked");
      expect(blockedEvents).toHaveLength(3);
      expect(blockedEvents[0]?.payload).toMatchObject({
        resource: "ghost_query",
        reason: "Unknown tool: ghost_query",
      });
      expect(blockedEvents[1]?.payload).toMatchObject({
        resource: "search.query",
        reason: "MCP server not found: search",
      });
      expect(blockedEvents[2]?.payload).toMatchObject({
        resource: "query",
        reason: "MCP tool name must be prefixed with server name: query",
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});

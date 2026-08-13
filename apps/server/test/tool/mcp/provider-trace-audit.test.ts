import { describe, expect, it } from "bun:test";
import { McpClient } from "@openomni/agent";
import type { TraceContext } from "@openomni/protocol";
import { Mcp, Operational, PolicyEvent, ToolExecution } from "@openomni/protocol";
import { McpToolProvider } from "../../../src/tool/mcp";
import { refreshMcpTools } from "../../../src/tool/mcp/provider-tool-listing";
import {
  TEST_BOOT_TRACE_ID,
  collectBusEvents,
  executionContext,
  installStorageFixture,
  makeTool,
  seedProvider,
} from "./provider-test-fixture";

installStorageFixture();

/**
 * The audit identity is the executor's, and a `sessionId` in the tool input
 * never becomes it. The identity used to be minted here when no context
 * arrived; it is now inherited, so the same claim is checked against the
 * inherited value rather than against "some string that is not the spoof".
 */
function expectInheritedAuditIdentity(
  events: ReturnType<typeof collectBusEvents>["events"],
  spoofedSessionId: string,
): void {
  const inherited = executionContext().traceContext as {
    traceId: string;
    sessionId: string;
    runId: string;
  };
  expect(inherited.sessionId).not.toBe(spoofedSessionId);
  for (const event of events) {
    expect(event.payload.traceId).toBe(inherited.traceId);
    // `Mcp.*` descriptors carry the trace and the server name only; session
    // and run attribution lives on the policy and tool-execution events.
    if (!event.name.startsWith("mcp.")) {
      expect(event.payload).toMatchObject({
        sessionId: inherited.sessionId,
        runId: inherited.runId,
      });
    }
  }
}

describe("McpToolProvider canonical policy trace", () => {
  it("uses the active trace for every successful MCP execution event", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    const { tool, execute } = makeTool("search.query");
    seedProvider(provider, [tool], ["search"]);
    const controller = new AbortController();
    const traceContext: TraceContext.Type = {
      traceId: "trace-mcp-execution",
      sessionId: "session-mcp-execution",
      runId: "run-mcp-execution",
      taskId: "task-mcp-execution",
      agentName: "agent-mcp-execution",
      parentSpanId: "span-mcp-execution",
    };
    const executionContext = { signal: controller.signal, traceContext };
    const { events, stop } = collectBusEvents();

    try {
      await provider.execute(
        {
          id: "call-mcp-execution",
          tool: "search_query",
          input: { sessionId: "spoofed-session" },
        },
        executionContext,
      );

      const auditEvents = events.filter((event) => event.name !== Operational.Debug.name);
      // #522 defect 2: ToolExecution.Completed is emitted solely by the
      // worker-side executor dispatching this provider — not by this layer.
      expect(auditEvents.map((event) => event.name)).toEqual([
        PolicyEvent.Evaluated.name,
        PolicyEvent.DecisionComposed.name,
        PolicyEvent.ActionRequested.name,
        Mcp.ToolCompleted.name,
      ]);
      for (const event of auditEvents) {
        expect(event.payload.traceId).toBe(traceContext.traceId);
        if (event.name !== Mcp.ToolCompleted.name) {
          expect(event.payload).toMatchObject({
            sessionId: traceContext.sessionId,
            runId: traceContext.runId,
          });
        }
      }
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: "call-mcp-execution", tool: "search.query" }),
        {
          signal: controller.signal,
          traceContext: {
            traceId: traceContext.traceId,
            sessionId: traceContext.sessionId,
            runId: traceContext.runId,
          },
        },
      );
    } finally {
      stop();
    }
  });

  it("uses the active trace for every blocked MCP execution event", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    const { tool, execute } = makeTool("search.query");
    seedProvider(provider, [tool]);
    const traceContext: TraceContext.Type = {
      traceId: "trace-mcp-blocked",
      sessionId: "session-mcp-blocked",
      runId: "run-mcp-blocked",
    };
    const { events, stop } = collectBusEvents();

    try {
      const result = await provider.execute(
        {
          id: "call-mcp-blocked",
          tool: "search_query",
          input: { sessionId: "spoofed-blocked-session" },
        },
        { traceContext },
      );

      expect(result.output).toBe("MCP server not found: search");
      const auditEvents = events.filter((event) => event.name !== Operational.Debug.name);
      expect(auditEvents.map((event) => event.name)).toEqual([
        PolicyEvent.Evaluated.name,
        PolicyEvent.DecisionComposed.name,
        PolicyEvent.ActionBlocked.name,
      ]);
      for (const event of auditEvents) {
        expect(event.payload).toMatchObject(traceContext);
      }
      expect(execute).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  /**
   * An MCP call is never a trace origin. Without the dispatching run's trace
   * there is nothing to attribute the audit record to, so the call is refused
   * rather than filed under an identity no reader can reach.
   */
  it("refuses a call that arrives without the dispatching trace", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    const { tool, execute } = makeTool("search.query");
    seedProvider(provider, [tool], ["search"]);

    for (const traceContext of [
      undefined,
      { traceId: "t", sessionId: "s" },
      { traceId: "", sessionId: "s", runId: "r" },
      { traceId: "t", sessionId: "", runId: "r" },
      { traceId: "t", sessionId: "s", runId: "" },
    ]) {
      await expect(
        provider.execute(
          { id: "call-mcp-traceless", tool: "search_query", input: {} },
          traceContext === undefined ? undefined : { traceContext },
        ),
      ).rejects.toThrow("mcp tool execution requires the dispatching run trace");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps one inherited audit identity for a successful call", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    const { tool } = makeTool("search.query");
    seedProvider(provider, [tool], ["search"]);
    const { events, stop } = collectBusEvents();

    try {
      await provider.execute(
        {
          id: "call-mcp-fallback",
          tool: "search_query",
          input: { sessionId: "spoofed-session" },
        },
        executionContext(),
      );

      const auditEvents = events.filter((event) => event.name !== Operational.Debug.name);
      expect(auditEvents.map((event) => event.name)).toEqual([
        PolicyEvent.Evaluated.name,
        PolicyEvent.DecisionComposed.name,
        PolicyEvent.ActionRequested.name,
        Mcp.ToolCompleted.name,
      ]);
      expectInheritedAuditIdentity(auditEvents, "spoofed-session");
    } finally {
      stop();
    }
  });

  it("keeps one inherited trace across provider and real MCP client events", async () => {
    // Given
    const client = new McpClient(
      {
        name: "search",
        transport: "sse",
        url: "https://example.test/mcp",
      },
      {
        client: {
          connect: async () => undefined,
          close: async () => undefined,
          listTools: async () => ({
            tools: [
              {
                name: "query",
                description: "Search query",
                inputSchema: { type: "object" as const },
              },
            ],
          }),
          callTool: async () => ({
            content: [{ type: "text" as const, text: "search ok" }],
          }),
        },
      },
    );
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    const tools = await refreshMcpTools(new Map([["search", client]]), TEST_BOOT_TRACE_ID);
    seedProvider(provider, tools, ["search"]);
    const { events, stop } = collectBusEvents();

    try {
      // When
      const result = await provider.execute(
        {
          id: "call-mcp-cross-layer-fallback",
          tool: "search_query",
          input: { sessionId: "spoofed-session" },
        },
        executionContext(),
      );

      // Then
      expect(result.output).toBe("search ok");
      // #522 defect 2: no ToolExecution.Completed at this layer — the
      // worker-side executor owns it. The provider's own audit trail keeps
      // one inherited trace across policy and MCP-domain events.
      const relevantNames = new Set([
        PolicyEvent.ActionRequested.name,
        Mcp.ToolCalled.name,
        ToolExecution.Completed.name,
        Mcp.ToolCompleted.name,
      ]);
      const relevantEvents = events.filter((event) => relevantNames.has(event.name));
      expect(relevantEvents.map((event) => event.name)).toEqual([
        PolicyEvent.ActionRequested.name,
        Mcp.ToolCalled.name,
        Mcp.ToolCompleted.name,
      ]);
      expectInheritedAuditIdentity(relevantEvents, "spoofed-session");
    } finally {
      stop();
    }
  });

  it("keeps one inherited audit identity for a blocked call", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    const { tool, execute } = makeTool("search.query");
    seedProvider(provider, [tool]);
    const { events, stop } = collectBusEvents();

    try {
      await provider.execute(
        {
          id: "call-mcp-fallback-blocked",
          tool: "search_query",
          input: { sessionId: "spoofed-session" },
        },
        executionContext(),
      );

      const auditEvents = events.filter((event) => event.name !== Operational.Debug.name);
      expect(auditEvents.map((event) => event.name)).toEqual([
        PolicyEvent.Evaluated.name,
        PolicyEvent.DecisionComposed.name,
        PolicyEvent.ActionBlocked.name,
      ]);
      expectInheritedAuditIdentity(auditEvents, "spoofed-session");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});

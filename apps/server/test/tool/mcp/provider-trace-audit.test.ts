import { describe, expect, it } from "bun:test";
import { McpClient } from "@openomni/agent";
import type { TraceContext } from "@openomni/protocol";
import { Mcp, Operational, PolicyEvent, ToolExecution } from "@openomni/protocol";
import { McpToolProvider } from "../../../src/tool/mcp";
import { refreshMcpTools } from "../../../src/tool/mcp/provider-tool-listing";
import {
  collectBusEvents,
  installStorageFixture,
  makeTool,
  seedProvider,
} from "./provider-test-fixture";

installStorageFixture();

function expectFallbackAuditIdentity(
  events: ReturnType<typeof collectBusEvents>["events"],
  spoofedSessionId: string,
): void {
  const { traceId, sessionId, runId } = events[0]?.payload ?? {};
  expect(typeof traceId).toBe("string");
  expect(typeof sessionId).toBe("string");
  expect(sessionId).not.toBe(spoofedSessionId);
  expect(typeof runId).toBe("string");
  for (const event of events) {
    expect(event.payload.traceId).toBe(traceId);
    if (event.name !== Mcp.ToolCompleted.name) {
      expect(event.payload).toMatchObject({ sessionId, runId });
    }
  }
}

describe("McpToolProvider canonical policy trace", () => {
  it("uses the active trace for every successful MCP execution event", async () => {
    const provider = new McpToolProvider();
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
    const provider = new McpToolProvider();
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

  it("uses one fallback audit identity for a successful context-free call", async () => {
    const provider = new McpToolProvider();
    const { tool } = makeTool("search.query");
    seedProvider(provider, [tool], ["search"]);
    const { events, stop } = collectBusEvents();

    try {
      await provider.execute({
        id: "call-mcp-fallback",
        tool: "search_query",
        input: { sessionId: "session-mcp-fallback" },
      });

      const auditEvents = events.filter((event) => event.name !== Operational.Debug.name);
      expect(auditEvents.map((event) => event.name)).toEqual([
        PolicyEvent.Evaluated.name,
        PolicyEvent.DecisionComposed.name,
        PolicyEvent.ActionRequested.name,
        Mcp.ToolCompleted.name,
      ]);
      expectFallbackAuditIdentity(auditEvents, "session-mcp-fallback");
    } finally {
      stop();
    }
  });

  it("uses one fallback trace across provider and real MCP client events", async () => {
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
    const provider = new McpToolProvider();
    const tools = await refreshMcpTools(new Map([["search", client]]));
    seedProvider(provider, tools, ["search"]);
    const { events, stop } = collectBusEvents();

    try {
      // When
      const result = await provider.execute({
        id: "call-mcp-cross-layer-fallback",
        tool: "search_query",
        input: { sessionId: "spoofed-session" },
      });

      // Then
      expect(result.output).toBe("search ok");
      // #522 defect 2: no ToolExecution.Completed at this layer — the
      // worker-side executor owns it. The provider's own audit trail keeps
      // one fallback trace across policy and MCP-domain events.
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
      const traceIds = new Set(relevantEvents.map((event) => event.payload.traceId));
      expect(traceIds.size).toBe(1);
      const [traceId] = traceIds;
      expect(typeof traceId).toBe("string");
      expect(traceId).not.toBe("");

      const action = relevantEvents[0]?.payload;
      expect(action?.sessionId).not.toBe("spoofed-session");
      expect(typeof action?.sessionId).toBe("string");
      expect(typeof action?.runId).toBe("string");
    } finally {
      stop();
    }
  });

  it("uses one fallback audit identity for a blocked context-free call", async () => {
    const provider = new McpToolProvider();
    const { tool, execute } = makeTool("search.query");
    seedProvider(provider, [tool]);
    const { events, stop } = collectBusEvents();

    try {
      await provider.execute({
        id: "call-mcp-fallback-blocked",
        tool: "search_query",
        input: { sessionId: "session-mcp-fallback-blocked" },
      });

      const auditEvents = events.filter((event) => event.name !== Operational.Debug.name);
      expect(auditEvents.map((event) => event.name)).toEqual([
        PolicyEvent.Evaluated.name,
        PolicyEvent.DecisionComposed.name,
        PolicyEvent.ActionBlocked.name,
      ]);
      expectFallbackAuditIdentity(auditEvents, "session-mcp-fallback-blocked");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});

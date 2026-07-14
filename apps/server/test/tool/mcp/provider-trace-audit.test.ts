import { describe, expect, it } from "bun:test";
import type { TraceContext } from "@openomni/protocol";
import { Mcp, Operational, PolicyEvent, ToolExecution } from "@openomni/protocol";
import { McpToolProvider } from "../../../src/tool/mcp";
import {
  collectBusEvents,
  installStorageFixture,
  makeTool,
  seedProvider,
} from "./provider-test-fixture";

installStorageFixture();

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
      expect(auditEvents.map((event) => event.name)).toEqual([
        PolicyEvent.Evaluated.name,
        PolicyEvent.DecisionComposed.name,
        PolicyEvent.ActionRequested.name,
        ToolExecution.Completed.name,
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
        executionContext,
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
      const traceId = auditEvents[0]?.payload.traceId;
      const runId = auditEvents[0]?.payload.runId;
      expect(typeof traceId).toBe("string");
      expect(typeof runId).toBe("string");
      expect(auditEvents.map((event) => event.name)).toEqual([
        PolicyEvent.Evaluated.name,
        PolicyEvent.DecisionComposed.name,
        PolicyEvent.ActionRequested.name,
        ToolExecution.Completed.name,
        Mcp.ToolCompleted.name,
      ]);
      for (const event of auditEvents) {
        expect(event.payload.traceId).toBe(traceId);
        if (event.name !== Mcp.ToolCompleted.name) {
          expect(event.payload).toMatchObject({
            sessionId: "session-mcp-fallback",
            runId,
          });
        }
      }
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
      const traceId = auditEvents[0]?.payload.traceId;
      const runId = auditEvents[0]?.payload.runId;
      expect(typeof traceId).toBe("string");
      expect(typeof runId).toBe("string");
      expect(auditEvents.map((event) => event.name)).toEqual([
        PolicyEvent.Evaluated.name,
        PolicyEvent.DecisionComposed.name,
        PolicyEvent.ActionBlocked.name,
      ]);
      for (const event of auditEvents) {
        expect(event.payload).toMatchObject({
          traceId,
          sessionId: "session-mcp-fallback-blocked",
          runId,
        });
      }
      expect(execute).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});

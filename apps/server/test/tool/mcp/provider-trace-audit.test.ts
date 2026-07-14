import { describe, expect, it } from "bun:test";
import type { TraceContext } from "@openomni/protocol";
import { PolicyEvent } from "@openomni/protocol";
import { McpToolProvider } from "../../../src/tool/mcp";
import {
  collectBusEvents,
  installStorageFixture,
  makeTool,
  seedProvider,
} from "./provider-test-fixture";

installStorageFixture();

describe("McpToolProvider canonical policy trace", () => {
  it("correlates canonical policy audit with the active tool execution trace", async () => {
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
        { id: "call-mcp-execution", tool: "search_query", input: {} },
        executionContext,
      );

      const pointEvents = events.filter(
        (event) =>
          (event.name === PolicyEvent.Evaluated.name ||
            event.name === PolicyEvent.DecisionComposed.name) &&
          event.payload.pointId === "tool.mcp.pre",
      );
      expect(pointEvents).toHaveLength(2);
      for (const event of pointEvents) {
        expect(event.payload).toMatchObject(traceContext);
      }
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: "call-mcp-execution", tool: "search.query" }),
        executionContext,
      );
    } finally {
      stop();
    }
  });
});

import { describe, expect, it, mock } from "bun:test";

import type { NativeTool } from "@openomni/openomni";
import type { Tool } from "@openomni/protocol";
import { Mcp } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { McpToolProvider } from "../../../src/tool/mcp";
import {
  TEST_BOOT_TRACE_ID,
  executionContext,
  installStorageFixture,
  makeTool,
  seedProvider,
} from "./provider-test-fixture";

installStorageFixture();

describe("McpToolProvider", () => {
  it("emits Mcp.Events.ToolCompleted event on successful tool execution", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    const { tool } = makeTool("search.query");
    seedProvider(provider, [tool], ["search"]);

    const publishedEvents: Array<{ name: string; payload: unknown }> = [];
    const unsubscribe = Bus.subscribe(Mcp.Events.ToolCompleted, (payload) => {
      publishedEvents.push({ name: "mcp.tool.completed", payload });
    });

    try {
      const result = await provider.execute(
        {
          id: "call-success",
          tool: "search_query",
          input: { query: "test" },
        },
        executionContext(),
      );

      expect(result.isError).toBeFalsy();
      expect(publishedEvents).toHaveLength(1);
      const event = publishedEvents[0]?.payload;
      if (
        typeof event !== "object" ||
        event === null ||
        !("toolCallId" in event) ||
        !("toolName" in event) ||
        !("durationMs" in event) ||
        !("resultSummary" in event)
      ) {
        throw new Error("expected MCP completion payload");
      }
      expect(event.toolCallId).toBe("call-success");
      expect(event.toolName).toBe("search.query");
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.resultSummary).toContain("success");
    } finally {
      unsubscribe();
    }
  });

  it("does not emit Mcp.Events.ToolCompleted on guard-denied execution", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    const { tool } = makeTool("search.query");
    seedProvider(provider, [tool], ["search"]);

    const publishedEvents: Array<{ name: string; payload: unknown }> = [];
    const unsubscribe = Bus.subscribe(Mcp.Events.ToolCompleted, (payload) => {
      publishedEvents.push({ name: "mcp.tool.completed", payload });
    });

    try {
      const result = await provider.execute(
        {
          id: "call-denied",
          tool: "ghost_query",
          input: {},
        },
        executionContext(),
      );

      expect(result.isError).toBeTruthy();
      expect(publishedEvents).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it("does not emit Mcp.Events.ToolCompleted on error result", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
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
    const unsubscribe = Bus.subscribe(Mcp.Events.ToolCompleted, (payload) => {
      publishedEvents.push({ name: "mcp.tool.completed", payload });
    });

    try {
      const result = await provider.execute(
        {
          id: "call-error",
          tool: "search_query",
          input: {},
        },
        executionContext(),
      );

      expect(result.isError).toBeTruthy();
      expect(publishedEvents).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });
});

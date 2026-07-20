import { afterEach, describe, expect, test } from "bun:test";
import { Mcp } from "@openomni/protocol";
import { Bus, type BusEvent } from "@openomni/session";
import { McpClient, type McpClientHandle } from "../../../src/runtime/mcp/client";

const config = {
  name: "search-server",
  transport: "sse",
  url: "https://example.test/mcp",
} as const;

function createClient(callTool: McpClientHandle["callTool"]): McpClient {
  return new McpClient(config, {
    client: {
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => ({ tools: [] }),
      callTool,
    },
  });
}

function nextEvent<T>(event: BusEvent.Descriptor<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    const unsubscribe = Bus.subscribe(event, (data) => {
      unsubscribe();
      resolve(data);
    });
  });
}

describe("McpClient call audit trace", () => {
  afterEach(() => {
    Bus.reset();
  });

  test("uses the execution trace for called and failed events", async () => {
    // Given
    Bus.reset();
    const traceContext = {
      traceId: "trace-mcp-active",
      sessionId: "session-mcp-active",
      runId: "run-mcp-active",
    } as const;
    const failure = new Error("remote MCP failure");
    const client = createClient(async () => {
      throw failure;
    });
    const called = nextEvent(Mcp.ToolCalled);
    const failed = nextEvent(Mcp.ToolFailed);

    // When
    const result = client.callTool("search-server.search", {}, "call-active", {
      traceContext,
    });

    // Then
    expect(await result.catch((error: unknown) => error)).toBe(failure);
    expect((await called).traceId).toBe(traceContext.traceId);
    expect((await failed).traceId).toBe(traceContext.traceId);
  });

  test("uses one generated fallback trace for a context-free failed call", async () => {
    // Given
    Bus.reset();
    const failure = new Error("remote MCP failure");
    const client = createClient(async () => {
      throw failure;
    });
    const called = nextEvent(Mcp.ToolCalled);
    const failed = nextEvent(Mcp.ToolFailed);

    // When
    const result = client.callTool("search-server.search", {}, "call-fallback");

    // Then
    expect(await result.catch((error: unknown) => error)).toBe(failure);
    const calledEvent = await called;
    const failedEvent = await failed;
    expect(calledEvent.traceId).not.toBe("");
    expect(failedEvent.traceId).toBe(calledEvent.traceId);
  });
});

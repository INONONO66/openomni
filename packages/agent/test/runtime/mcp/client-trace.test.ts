import { afterEach, describe, expect, test } from "bun:test";
import { Mcp } from "@openomni/protocol";
import { Bus, type BusEvent } from "@openomni/session";
import { McpClient, type McpClientHandle } from "../../../src/runtime/mcp/client";

/** An MCP server's lifecycle belongs to whatever brought it up — the boot. */
const TEST_LIFECYCLE_TRACE_ID = "trace-mcp-lifecycle";

const config = {
  name: "search-server",
  transport: "sse",
  url: "https://example.test/mcp",
} as const;

function createClient(callTool: McpClientHandle["callTool"]): McpClient {
  return new McpClient(config, {
    traceId: TEST_LIFECYCLE_TRACE_ID,
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

  /**
   * A tool call is never a trace origin: the executor that dispatches it
   * already refused a call without one. A caller reaching past that is
   * refused here rather than filed under an invented id.
   */
  test("refuses a context-free call", async () => {
    Bus.reset();
    const client = createClient(async () => ({ content: [] }));

    for (const context of [undefined, { traceContext: { traceId: "" } }]) {
      await expect(
        client.callTool("search-server.search", {}, "call-traceless", context),
      ).rejects.toThrow("mcp tool call requires the run trace context");
    }
  });

  /**
   * The lifecycle record carries the trace of whatever brought the server up,
   * and nothing at all when there is none. Asserting only that a record
   * exists leaves a re-mint free to satisfy it.
   */
  test("files connect under the lifecycle trace", async () => {
    Bus.reset();
    const connected = nextEvent(Mcp.Connected);
    const client = createClient(async () => ({ content: [] }));

    await client.connect();

    expect((await connected).traceId).toBe(TEST_LIFECYCLE_TRACE_ID);
  });

  test("publishes no lifecycle record when it has no trace", async () => {
    Bus.reset();
    const seen: string[] = [];
    const unsubscribe = Bus.observe((descriptor) => seen.push(descriptor.name));
    const client = new McpClient(config, {
      client: {
        connect: async () => undefined,
        close: async () => undefined,
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
      },
    });

    try {
      await client.connect();
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    expect(seen.filter((name) => name.startsWith("mcp."))).toEqual([]);
  });
});

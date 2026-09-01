import { afterEach, describe, expect, test } from "bun:test";
import { Mcp } from "@openomni/protocol";
import type { BusEvent } from "@openomni/protocol";
import { Bus, collector } from "@openomni/telemetry";
import { captureBusEvents } from "../../helpers/bus-event";
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
    events: Bus,
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
  return captureBusEvents(event).done.then(([data]) => {
    if (data === undefined) throw new Error(`Expected ${event.name}`);
    return data;
  });
}

describe("McpClient call audit trace", () => {
  afterEach(() => {
    Bus.reset();
  });

  test("publishes the exact success payload for a completed tool call", async () => {
    const client = createClient(async () => ({ content: [{ type: "text", text: "found it" }] }));
    const completed = nextEvent(Mcp.Events.ToolCompleted);

    const result = await client.callTool("search-server.search", {}, "call-complete", {
      traceContext: {
        traceId: "trace-mcp-complete",
        sessionId: "session-mcp-complete",
        runId: "run-mcp-complete",
      },
    });

    expect(result.output).toBe("found it");
    expect(await completed).toMatchObject({
      traceId: "trace-mcp-complete",
      serverName: "search-server",
      toolName: "search",
      toolCallId: "call-complete",
      resultSummary: "found it",
    });
    expect((await completed).durationMs).toBeGreaterThanOrEqual(0);
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
    const called = nextEvent(Mcp.Events.ToolCalled);
    const failed = nextEvent(Mcp.Events.ToolFailed);

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
  test("files connect and disconnect under the lifecycle trace", async () => {
    Bus.reset();
    const connected = nextEvent(Mcp.Events.Connected);
    const disconnected = nextEvent(Mcp.Events.Disconnected);
    const client = createClient(async () => ({ content: [] }));

    await client.connect();
    await client.disconnect();

    expect((await connected).traceId).toBe(TEST_LIFECYCLE_TRACE_ID);
    expect((await disconnected).traceId).toBe(TEST_LIFECYCLE_TRACE_ID);
  });

  /**
   * Audit L5: connect() is idempotent. A second connect on a live client used
   * to mint a second transport the first never closed — leaking the old
   * transport's process/socket when the SDK client rebound.
   */
  test("a second connect() on a live client creates no second transport", async () => {
    Bus.reset();
    let transportsCreated = 0;
    let connects = 0;
    const client = new McpClient(config, {
      events: Bus,
      traceId: TEST_LIFECYCLE_TRACE_ID,
      createTransport: () => {
        transportsCreated += 1;
        return {
          start: async () => undefined,
          send: async () => undefined,
          close: async () => undefined,
        };
      },
      client: {
        connect: async () => {
          connects += 1;
        },
        close: async () => undefined,
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
      },
    });

    await client.connect();
    await client.connect();

    expect(transportsCreated).toBe(1);
    expect(connects).toBe(1);

    // After a disconnect, a reconnect is a genuine new connection.
    await client.disconnect();
    await client.connect();
    expect(transportsCreated).toBe(2);
    expect(connects).toBe(2);
  });

  test.each([undefined, ""])("publishes no lifecycle record for traceId %j", async (traceId) => {
    Bus.reset();
    const events = collector();
    const client = new McpClient(config, {
      events,
      ...(traceId === undefined ? {} : { traceId }),
      client: {
        connect: async () => undefined,
        close: async () => undefined,
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
      },
    });

    await client.connect();
    await client.disconnect();

    // Not filtered to `mcp.*`: an operational error on the failure branch is
    // the same defect and should fail this too.
    expect(events.events).toEqual([]);
  });
});

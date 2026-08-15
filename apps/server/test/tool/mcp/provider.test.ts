import { describe, expect, it, mock } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";

import type { NativeTool } from "@openomni/openomni";
import type { Tool } from "@openomni/protocol";
import { McpToolProvider } from "../../../src/tool/mcp";
import {
  TEST_BOOT_TRACE_ID,
  executionContext,
  installStorageFixture,
  makeClient,
  makeTool,
  seedProvider,
} from "./provider-test-fixture";

installStorageFixture();

describe("McpToolProvider", () => {
  /**
   * The provider owns the boot trace and the client reports the server's
   * lifecycle under it. Pinning it inside `McpClient` proves only that the
   * client uses the trace it was handed, not that the provider hands it one.
   */
  it("hands its boot trace to the clients it creates", async () => {
    const seen: Array<{ component?: string; traceId: string }> = [];
    const unsubscribe = Bus.subscribe(Operational.Error, (event) => {
      seen.push(event as unknown as { component?: string; traceId: string });
    });
    // A real `McpClient`, not the injected stub: the stub would bypass the
    // construction this test exists to check. Connecting to a command that is
    // not there fails, and the client reports that failure under the trace the
    // provider handed it.
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });

    try {
      await provider.addServer({
        name: "search",
        transport: "stdio",
        command: "openomni-no-such-mcp-server",
      });
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    const fromClient = seen.filter((event) => event.component === "agent.mcp");
    expect(fromClient).toHaveLength(1);
    expect(fromClient[0]?.traceId).toBe(TEST_BOOT_TRACE_ID);
  });
  it("executes valid MCP-prefixed tools through the resolved canonical name", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    const { tool, execute } = makeTool("search.query");
    seedProvider(provider, [tool], ["search"]);

    const result = await provider.execute(
      {
        id: "call-1",
        tool: "search_query",
        input: { query: "hello" },
      },
      executionContext(),
    );

    expect(result).toMatchObject({
      toolCallId: "call-1",
      output: "search.query ok",
    });
    expect(execute).toHaveBeenCalledWith(
      {
        id: "call-1",
        tool: "search.query",
        input: { query: "hello" },
      },
      {
        traceContext: {
          traceId: expect.any(String),
          sessionId: expect.any(String),
          runId: expect.any(String),
        },
      },
    );
  });

  it("forwards execution context to resolved MCP tools", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    let capturedSignal: AbortSignal | undefined;
    const execute = mock(
      async (call: Tool.Call, context?: { signal?: AbortSignal }): Promise<Tool.Result> => {
        capturedSignal = context?.signal;
        return { id: call.id, toolCallId: call.id, output: `${call.tool} ok` };
      },
    );
    const tool: NativeTool = {
      spec: { name: "search.query", description: "search.query tool", inputSchema: {} },
      riskTier: 1,
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      source: "mcp",
      execute,
    };
    seedProvider(provider, [tool], ["search"]);
    const controller = new AbortController();

    const result = await provider.execute(
      { id: "call-context", tool: "search_query", input: { query: "hello" } },
      executionContext({ signal: controller.signal }),
    );

    expect(result.output).toBe("search.query ok");
    expect(capturedSignal).toBe(controller.signal);
  });

  it("exposes MCP labels and descriptors on refreshed tools for agent policy dispatch", async () => {
    const client = makeClient();
    client.listTools.mockResolvedValueOnce([
      { name: "search.query", description: "query", inputSchema: {}, labels: ["custom.label"] },
    ]);
    const provider = new McpToolProvider({
      traceId: TEST_BOOT_TRACE_ID,
      createClient: () => client.client,
    });

    await provider.addServer({ name: "search", transport: "stdio", command: "search-mcp" });
    await provider.refreshTools();

    const [tool] = provider.listTools();
    expect(tool.spec.labels).toEqual([
      "custom.label",
      "tool:search.query",
      "source:mcp",
      "mcp.search",
    ]);
    expect(tool.descriptor).toMatchObject({
      id: "tool:mcp:search:search.query",
      kind: "tool",
      source: { type: "mcp", serverId: "search", remoteName: "search.query" },
    });
  });

  it("preserves the unknown-tool error for unknown MCP prefixes", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    const { tool } = makeTool("search.query");
    seedProvider(provider, [tool], ["search"]);

    const result = await provider.execute(
      { id: "call-2", tool: "ghost_query", input: {} },
      executionContext(),
    );

    expect(result).toMatchObject({
      toolCallId: "call-2",
      output: "Unknown tool: ghost_query",
      isError: true,
    });
  });

  it("preserves the disconnected-server error for cached MCP tools", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    const { tool, execute } = makeTool("search.query");
    seedProvider(provider, [tool]);

    const result = await provider.execute(
      { id: "call-3", tool: "search_query", input: {} },
      executionContext(),
    );

    expect(result).toMatchObject({
      toolCallId: "call-3",
      output: "MCP server not found: search",
      isError: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves the missing-prefix error for MCP tools without server names", async () => {
    const provider = new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID });
    const { tool, execute } = makeTool("query");
    seedProvider(provider, [tool], ["query"]);

    const result = await provider.execute(
      { id: "call-4", tool: "query", input: {} },
      executionContext(),
    );

    expect(result).toMatchObject({
      toolCallId: "call-4",
      output: "MCP tool name must be prefixed with server name: query",
      isError: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

import { describe, expect, test } from "bun:test";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { McpClient, type McpClientHandle } from "../../../src/runtime/mcp/client";
import { createTransport } from "../../../src/runtime/mcp/client-transport";

const TRACE_ID = "trace-mcp-lifecycle";
const stdio = (name = "filesystem") => ({
  name,
  transport: "stdio" as const,
  command: "mcp-server-filesystem",
});
const http = (name = "search-server", transport: "sse" | "streamable-http" = "sse") => ({
  name,
  transport,
  url: "https://example.test/mcp",
});

interface McpToolStub {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: { readonly type: "object" } & Record<string, unknown>;
}
function stubClient(tools: McpToolStub[] = []): McpClientHandle {
  return {
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => ({ tools }),
    callTool: async () => {
      throw new Error("callTool is not implemented by this test stub");
    },
  };
}

function requestCaptureClient(tools: McpToolStub[] = []) {
  const listOptions: Array<RequestOptions | undefined> = [];
  const callOptions: Array<RequestOptions | undefined> = [];
  const client: McpClientHandle = {
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async (_params, options) => {
      listOptions.push(options);
      return { tools };
    },
    callTool: async (_params, _schema, options) => {
      callOptions.push(options);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  return { client, listOptions, callOptions };
}

function transportStub(emitOnClose = true): Transport & { readonly closeCalls: () => number } {
  let calls = 0;
  const transport: Transport & { readonly closeCalls: () => number } = {
    start: async () => undefined,
    send: async () => undefined,
    close: async () => {
      calls += 1;
      if (emitOnClose) transport.onclose?.();
    },
    closeCalls: () => calls,
  };
  return transport;
}

function connectableClient(options: {
  readonly connectError?: Error;
  readonly listToolsError?: Error;
  readonly closeError?: Error;
  readonly closeTransport?: boolean;
}) {
  let transport: Transport | undefined;
  let calls = 0;
  const client: McpClientHandle = {
    connect: async (next) => {
      transport = next;
      if (options.connectError) throw options.connectError;
    },
    close: async () => {
      calls += 1;
      if (options.closeError) throw options.closeError;
      if (options.closeTransport !== false) await transport?.close();
    },
    listTools: async () => {
      if (options.listToolsError) throw options.listToolsError;
      return { tools: [] };
    },
    callTool: async () => {
      throw new Error("callTool is not implemented by this test stub");
    },
  };
  return { client, closeCalls: () => calls };
}

function transportCaptureClient() {
  let captured: Transport | undefined;
  const client: McpClientHandle = {
    connect: async (transport) => {
      captured = transport;
    },
    close: async () => undefined,
    listTools: async () => ({ tools: [] }),
    callTool: async () => {
      throw new Error("callTool is not implemented by this test stub");
    },
  };
  return { client, transport: () => captured };
}

type CapturedTransport = Transport & {
  readonly _eventSourceInit?: { readonly fetch?: unknown };
  readonly _requestInit?: RequestInit;
  readonly _reconnectionOptions?: { readonly maxRetries?: number };
};
function httpOptions(transport: Transport | undefined) {
  expect(transport).toBeDefined();
  const captured = transport as CapturedTransport;
  return {
    eventSourceFetch: captured._eventSourceInit?.fetch,
    requestInit: captured._requestInit,
    reconnectionOptions: captured._reconnectionOptions,
  };
}

type ErrorPayload = {
  readonly component?: string;
  readonly error?: string;
  readonly context?: Record<string, unknown>;
};
function observeError(serverName: string) {
  const seen: ErrorPayload[] = [];
  let resolve!: (payload: ErrorPayload) => void;
  const next = new Promise<ErrorPayload>((done) => {
    resolve = done;
  });
  const unsubscribe = Bus.observe((event, payload) => {
    const error = payload as ErrorPayload;
    if (
      event.name === Operational.Events.Error.name &&
      error.component === "agent.mcp" &&
      error.context?.serverName === serverName
    ) {
      seen.push(error);
      resolve(error);
    }
  });
  return { seen, next, unsubscribe };
}

describe("MCP transport construction", () => {
  test("preserves the stdio command and argument vector", () => {
    const transport = createTransport({
      name: "filesystem",
      transport: "stdio",
      command: "mcp-server-filesystem",
      args: ["--root", "/workspace"],
    });

    expect(transport).toBeInstanceOf(StdioClientTransport);
    expect(
      (transport as unknown as {
        readonly _serverParams: { readonly command: string; readonly args?: string[] };
      })._serverParams,
    ).toEqual({ command: "mcp-server-filesystem", args: ["--root", "/workspace"] });
  });
});

describe("McpClient listed tools", () => {
  test("namespaces listed MCP tools", async () => {
    const client = new McpClient(stdio(), {
      events: Bus,
      traceId: TRACE_ID,
      client: stubClient([
        {
          name: "write_file",
          description: "Write a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ]),
    });
    const [tool] = await client.listTools();
    expect(tool?.name).toBe("filesystem.write_file");
  });

  test("preserves the remote MCP tool name after namespacing", async () => {
    const client = new McpClient(http(), {
      events: Bus,
      client: stubClient([{ name: "search", inputSchema: { type: "object" } }]),
    });
    const [tool] = await client.listTools();
    expect(tool?.name).toBe("search-server.search");
  });
});

describe("McpClient request options", () => {
  test.each([
    ["preserves SDK defaults when neither timeout nor signal is configured", undefined, undefined],
    ["ignores non-positive timeout overrides", 0, undefined],
  ] as const)("%s", async (_name, timeout, expected) => {
    const sdk = requestCaptureClient([{ name: "search", inputSchema: { type: "object" } }]);
    const client = new McpClient(
      { ...http(), ...(timeout !== undefined && { timeout }) },
      { events: Bus, client: sdk.client },
    );
    await client.listTools();
    expect(sdk.listOptions[0]).toBe(expected);
  });

  test("passes abort signal without requiring a timeout override", async () => {
    const sdk = requestCaptureClient([{ name: "search", inputSchema: { type: "object" } }]);
    const signal = new AbortController().signal;
    await new McpClient(http(), { events: Bus, client: sdk.client }).listTools({ signal });
    expect(sdk.listOptions[0]?.signal).toBe(signal);
    expect(sdk.listOptions[0]?.timeout).toBeUndefined();
    expect(sdk.listOptions[0]?.maxTotalTimeout).toBeUndefined();
  });

  test("passes configured timeout to initial tool discovery during connect", async () => {
    const sdk = requestCaptureClient();
    const client = new McpClient(
      { ...stdio(), timeout: 1234 },
      {
        events: Bus,
        traceId: TRACE_ID,
        client: sdk.client,
        createTransport: () => transportStub(),
      },
    );
    await client.connect();
    expect(sdk.listOptions[0]?.timeout).toBe(1234);
    expect(sdk.listOptions[0]?.maxTotalTimeout).toBe(1234);
  });

  test("passes configured timeout and abort signal to listTools", async () => {
    const sdk = requestCaptureClient([{ name: "search", inputSchema: { type: "object" } }]);
    const signal = new AbortController().signal;
    await new McpClient(
      { ...http(), timeout: 2500 },
      { events: Bus, client: sdk.client },
    ).listTools({ signal });
    expect(sdk.listOptions[0]?.signal).toBe(signal);
    expect(sdk.listOptions[0]?.timeout).toBe(2500);
    expect(sdk.listOptions[0]?.maxTotalTimeout).toBe(2500);
  });

  test("passes configured timeout and abort signal to callTool", async () => {
    const sdk = requestCaptureClient();
    const signal = new AbortController().signal;
    const result = await new McpClient(
      { ...stdio(), timeout: 5000 },
      { events: Bus, client: sdk.client },
    ).callTool("filesystem.read_file", { path: "README.md" }, "call-1", {
      signal,
      traceContext: { traceId: "trace-mcp-call" },
    });
    expect(result.output).toBe("ok");
    expect(sdk.callOptions[0]?.signal).toBe(signal);
    expect(sdk.callOptions[0]?.timeout).toBe(5000);
    expect(sdk.callOptions[0]?.maxTotalTimeout).toBe(5000);
  });

  test("passes configured headers to SSE transports", async () => {
    const sdk = transportCaptureClient();
    await new McpClient(
      { ...http(), headers: { Authorization: "Bearer token" } },
      { events: Bus, client: sdk.client },
    ).connect();
    const options = httpOptions(sdk.transport());
    expect(new Headers(options.requestInit?.headers).get("Authorization")).toBe("Bearer token");
    expect(options.eventSourceFetch).toBeFunction();
  });

  test("SSE EventSource header fetch handles omitted init", async () => {
    const sdk = transportCaptureClient();
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{
      readonly url: Parameters<typeof fetch>[0];
      readonly init?: RequestInit;
    }> = [];
    globalThis.fetch = (async (url, init) => {
      fetchCalls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      await new McpClient(
        { ...http(), headers: { Authorization: "Bearer token" } },
        { events: Bus, client: sdk.client },
      ).connect();
      const eventSourceFetch = httpOptions(sdk.transport()).eventSourceFetch;
      if (typeof eventSourceFetch !== "function")
        throw new TypeError("expected an eventSourceFetch on the SSE transport");
      await eventSourceFetch("https://example.test/mcp");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchCalls).toHaveLength(1);
    expect(new Headers(fetchCalls[0]?.init?.headers).get("Authorization")).toBe("Bearer token");
  });

  test("passes configured headers and retries to streamable HTTP transports", async () => {
    const sdk = transportCaptureClient();
    await new McpClient(
      {
        ...http("search-server", "streamable-http"),
        headers: { "x-api-key": "secret" },
        retries: 4,
      },
      { events: Bus, client: sdk.client },
    ).connect();
    const options = httpOptions(sdk.transport());
    expect(new Headers(options.requestInit?.headers).get("x-api-key")).toBe("secret");
    expect(options.reconnectionOptions?.maxRetries).toBe(4);
  });
});

describe("McpClient connection cleanup", () => {
  test.each([
    ["closes the MCP transport when client.connect fails", "connect", true, true],
    ["closes the MCP transport when initial tool discovery fails", "list", true, true],
    [
      "falls back to closing the transport directly if the client cleanup does not close it",
      "connect",
      false,
      true,
    ],
    [
      "does not double-close when the client closes a transport that omits onclose",
      "connect",
      true,
      false,
    ],
  ] as const)("%s", async (_name, failure, closeTransport, emitOnClose) => {
    const error = new Error(failure === "connect" ? "connect failed" : "tools/list failed");
    const sdk = connectableClient({
      ...(failure === "connect" ? { connectError: error } : { listToolsError: error }),
      closeTransport,
    });
    const transport = transportStub(emitOnClose);
    const client = new McpClient(failure === "list" ? http() : stdio(), {
      events: Bus,
      traceId: TRACE_ID,
      client: sdk.client,
      createTransport: () => transport,
    });
    await expect(client.connect()).rejects.toBe(error);
    expect(sdk.closeCalls()).toBe(1);
    expect(transport.closeCalls()).toBe(1);
  });

  test("reports cleanup failures without masking the original connection error", async () => {
    const connectError = new Error("connect failed");
    const sdk = connectableClient({ connectError, closeError: new Error("cleanup failed") });
    const transport = transportStub();
    const observed = observeError("filesystem-cleanup-error");
    const client = new McpClient(stdio("filesystem-cleanup-error"), {
      events: Bus,
      traceId: TRACE_ID,
      client: sdk.client,
      createTransport: () => transport,
    });
    try {
      await expect(client.connect()).rejects.toBe(connectError);
      await observed.next;
    } finally {
      observed.unsubscribe();
    }
    expect(sdk.closeCalls()).toBe(1);
    expect(transport.closeCalls()).toBe(1);
    expect(observed.seen).toHaveLength(1);
    expect(observed.seen[0]?.component).toBe("agent.mcp");
    expect(observed.seen[0]?.error).toBe("Error: connect failed");
    expect(observed.seen[0]?.context?.cleanupError).toBe("Error: cleanup failed");
  });

  const factoryError = new Error("transport factory failed");
  test.each([
    [
      "reports transport factory failures through operational errors",
      "factory-failure",
      factoryError,
      "Error: transport factory failed",
    ],
    [
      "preserves the explicit error for unknown runtime transports",
      "invalid-transport",
      "Unknown transport",
      "Error: Unknown transport",
    ],
  ] as const)("%s", async (_name, serverName, rejection, expectedError) => {
    const observed = observeError(serverName);
    const client =
      typeof rejection === "string"
        ? new McpClient({ ...stdio(serverName), transport: "invalid" } as never, {
            traceId: TRACE_ID,
            events: Bus,
          })
        : new McpClient(stdio(serverName), {
            events: Bus,
            traceId: TRACE_ID,
            client: stubClient(),
            createTransport: () => {
              throw rejection;
            },
          });
    try {
      if (typeof rejection === "string") {
        await expect(client.connect()).rejects.toThrow(rejection);
      } else {
        await expect(client.connect()).rejects.toBe(rejection);
      }
      await observed.next;
    } finally {
      observed.unsubscribe();
    }
    expect(observed.seen).toHaveLength(1);
    expect(observed.seen[0]?.component).toBe("agent.mcp");
    expect(observed.seen[0]?.error).toBe(expectedError);
    expect(observed.seen[0]?.context?.serverName).toBe(serverName);
    expect(observed.seen[0]?.context?.cleanupError).toBeUndefined();
  });
});

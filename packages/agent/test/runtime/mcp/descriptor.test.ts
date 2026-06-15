import { describe, expect, test } from "bun:test";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Operational, type RuntimeResource, type Tool } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { McpClient, type McpClientHandle } from "../../../src/runtime/mcp/client";

interface McpToolStub {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

type ToolSpecWithDescriptor = Tool.Spec & {
  readonly descriptor?: RuntimeResource.Descriptor;
};

function createStubClient(tools: McpToolStub[]): McpClientHandle {
  return {
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => ({ tools }),
    callTool: async () => {
      throw new Error("callTool is not implemented by this test stub");
    },
  };
}

function createRequestOptionsCaptureClient(tools: McpToolStub[] = []): McpClientHandle & {
  readonly listOptions: () => Array<RequestOptions | undefined>;
  readonly callOptions: () => Array<RequestOptions | undefined>;
} {
  const capturedListOptions: Array<RequestOptions | undefined> = [];
  const capturedCallOptions: Array<RequestOptions | undefined> = [];

  return {
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async (_params, options) => {
      capturedListOptions.push(options);
      return { tools };
    },
    callTool: async (_params, _resultSchema, options) => {
      capturedCallOptions.push(options);
      return { content: [{ type: "text", text: "ok" }] };
    },
    listOptions: () => capturedListOptions,
    callOptions: () => capturedCallOptions,
  };
}

describe("McpClient tool descriptors", () => {
  test("attaches RuntimeResource descriptors to listed MCP tools", async () => {
    const client = new McpClient(
      {
        name: "filesystem",
        transport: "stdio",
        command: "mcp-server-filesystem",
      },
      {
        client: createStubClient([
          {
            name: "write_file",
            description: "Write a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
          },
        ]),
      },
    );

    const [tool] = (await client.listTools()) as ToolSpecWithDescriptor[];

    expect(tool?.name).toBe("filesystem.write_file");
    expect(tool?.labels).toEqual(["source.mcp", "mcp.filesystem"]);
    expect(tool?.descriptor).toEqual({
      id: "tool:mcp:filesystem:write_file",
      kind: "tool",
      source: {
        type: "mcp",
        serverId: "filesystem",
        remoteName: "write_file",
      },
      labels: ["source.mcp", "mcp.filesystem"],
      capabilities: ["network.write"],
      effects: ["external.write"],
    });
  });

  test("uses the remote MCP tool name in descriptor source metadata", async () => {
    const client = new McpClient(
      {
        name: "search-server",
        transport: "sse",
        url: "https://example.test/mcp",
      },
      { client: createStubClient([{ name: "search" }]) },
    );

    const [tool] = (await client.listTools()) as ToolSpecWithDescriptor[];

    expect(tool?.name).toBe("search-server.search");
    expect(tool?.descriptor?.id).toBe("tool:mcp:search-server:search");
    expect(tool?.descriptor?.source).toEqual({
      type: "mcp",
      serverId: "search-server",
      remoteName: "search",
    });
  });
});

describe("McpClient request options", () => {
  test("preserves SDK defaults when neither timeout nor signal is configured", async () => {
    const sdkClient = createRequestOptionsCaptureClient([{ name: "search" }]);
    const client = new McpClient(
      {
        name: "search-server",
        transport: "sse",
        url: "https://example.test/mcp",
      },
      { client: sdkClient },
    );

    await client.listTools();

    expect(sdkClient.listOptions()[0]).toBeUndefined();
  });

  test("passes abort signal without requiring a timeout override", async () => {
    const sdkClient = createRequestOptionsCaptureClient([{ name: "search" }]);
    const signal = new AbortController().signal;
    const client = new McpClient(
      {
        name: "search-server",
        transport: "sse",
        url: "https://example.test/mcp",
      },
      { client: sdkClient },
    );

    await client.listTools({ signal });

    const options = sdkClient.listOptions()[0];
    expect(options?.signal).toBe(signal);
    expect(options?.timeout).toBeUndefined();
    expect(options?.maxTotalTimeout).toBeUndefined();
  });

  test("ignores non-positive timeout overrides", async () => {
    const sdkClient = createRequestOptionsCaptureClient([{ name: "search" }]);
    const client = new McpClient(
      {
        name: "search-server",
        transport: "sse",
        url: "https://example.test/mcp",
        timeout: 0,
      },
      { client: sdkClient },
    );

    await client.listTools();

    expect(sdkClient.listOptions()[0]).toBeUndefined();
  });

  test("passes configured timeout to initial tool discovery during connect", async () => {
    const sdkClient = createRequestOptionsCaptureClient();
    const client = new McpClient(
      {
        name: "filesystem",
        transport: "stdio",
        command: "mcp-server-filesystem",
        timeout: 1234,
      },
      {
        client: sdkClient,
        createTransport: () => createTransportStub(),
      },
    );

    await client.connect();

    const options = sdkClient.listOptions()[0];
    expect(options?.timeout).toBe(1234);
    expect(options?.maxTotalTimeout).toBe(1234);
  });

  test("passes configured timeout and abort signal to listTools", async () => {
    const sdkClient = createRequestOptionsCaptureClient([{ name: "search" }]);
    const signal = new AbortController().signal;
    const client = new McpClient(
      {
        name: "search-server",
        transport: "sse",
        url: "https://example.test/mcp",
        timeout: 2500,
      },
      { client: sdkClient },
    );

    await client.listTools({ signal });

    const options = sdkClient.listOptions()[0];
    expect(options?.signal).toBe(signal);
    expect(options?.timeout).toBe(2500);
    expect(options?.maxTotalTimeout).toBe(2500);
  });

  test("passes configured timeout and abort signal to callTool", async () => {
    const sdkClient = createRequestOptionsCaptureClient();
    const signal = new AbortController().signal;
    const client = new McpClient(
      {
        name: "filesystem",
        transport: "stdio",
        command: "mcp-server-filesystem",
        timeout: 5000,
      },
      { client: sdkClient },
    );

    const result = await client.callTool("filesystem.read_file", { path: "README.md" }, "call-1", {
      signal,
    });

    expect(result.output).toBe("ok");
    const options = sdkClient.callOptions()[0];
    expect(options?.signal).toBe(signal);
    expect(options?.timeout).toBe(5000);
    expect(options?.maxTotalTimeout).toBe(5000);
  });

  test("passes configured headers to SSE transports", async () => {
    const sdkClient = createTransportCaptureClient();
    const client = new McpClient(
      {
        name: "search-server",
        transport: "sse",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer token" },
      },
      { client: sdkClient },
    );

    await client.connect();

    const options = capturedHttpTransportOptions(sdkClient.transport());
    expect(new Headers(options.requestInit?.headers).get("Authorization")).toBe("Bearer token");
    expect(options.eventSourceFetch).toBeFunction();
  });

  test("SSE EventSource header fetch handles omitted init", async () => {
    const sdkClient = createTransportCaptureClient();
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{ readonly url: string | URL; readonly init?: RequestInit }> = [];
    globalThis.fetch = (async (url, init) => {
      fetchCalls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    try {
      const client = new McpClient(
        {
          name: "search-server",
          transport: "sse",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer token" },
        },
        { client: sdkClient },
      );

      await client.connect();

      const eventSourceFetch = capturedHttpTransportOptions(sdkClient.transport()).eventSourceFetch;
      expect(eventSourceFetch).toBeFunction();
      await eventSourceFetch("https://example.test/mcp");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toHaveLength(1);
    expect(new Headers(fetchCalls[0]?.init?.headers).get("Authorization")).toBe("Bearer token");
  });

  test("passes configured headers and retries to streamable HTTP transports", async () => {
    const sdkClient = createTransportCaptureClient();
    const client = new McpClient(
      {
        name: "search-server",
        transport: "streamable-http",
        url: "https://example.test/mcp",
        headers: { "x-api-key": "secret" },
        retries: 4,
      },
      { client: sdkClient },
    );

    await client.connect();

    const options = capturedHttpTransportOptions(sdkClient.transport());
    expect(new Headers(options.requestInit?.headers).get("x-api-key")).toBe("secret");
    expect(options.reconnectionOptions?.maxRetries).toBe(4);
  });
});

function createTransportCaptureClient(tools: McpToolStub[] = []): McpClientHandle & {
  readonly transport: () => Transport | undefined;
} {
  let transport: Transport | undefined;
  return {
    connect: async (nextTransport) => {
      transport = nextTransport;
    },
    close: async () => undefined,
    listTools: async () => ({ tools }),
    callTool: async () => {
      throw new Error("callTool is not implemented by this test stub");
    },
    transport: () => transport,
  };
}

interface CapturedHttpTransportOptions {
  readonly eventSourceFetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  readonly requestInit?: RequestInit;
  readonly reconnectionOptions?: { readonly maxRetries?: number };
}

// The MCP SDK accepts these options through public transport constructors, but
// does not expose them through a public read API. These transport-option tests
// therefore use guarded, documented white-box reads as the smallest connect-free
// assertion point for verifying the options passed by McpClient.
function capturedHttpTransportOptions(
  transport: Transport | undefined,
): CapturedHttpTransportOptions {
  expect(transport).toBeDefined();
  const captured = transport as TransportWithCapturedHttpOptions;
  const eventSourceFetch = captured._eventSourceInit?.fetch;
  return {
    eventSourceFetch:
      typeof eventSourceFetch === "function"
        ? (eventSourceFetch as CapturedHttpTransportOptions["eventSourceFetch"])
        : undefined,
    requestInit: captured._requestInit,
    reconnectionOptions: captured._reconnectionOptions,
  };
}

type TransportWithCapturedHttpOptions = Transport & {
  readonly _eventSourceInit?: { readonly fetch?: unknown };
  readonly _requestInit?: RequestInit;
  readonly _reconnectionOptions?: { readonly maxRetries?: number };
};

function createTransportStub(options: { readonly emitOnClose?: boolean } = {}): Transport & {
  readonly closeCalls: () => number;
} {
  let closeCalls = 0;

  const transport: Transport & { readonly closeCalls: () => number } = {
    start: async () => undefined,
    send: async () => undefined,
    close: async () => {
      closeCalls += 1;
      if (options.emitOnClose !== false) {
        transport.onclose?.();
      }
    },
    closeCalls: () => closeCalls,
  };

  return transport;
}

function createConnectableStubClient(options: {
  readonly connectError?: Error;
  readonly listToolsError?: Error;
  readonly closeError?: Error;
  readonly closeTransport?: boolean;
}): McpClientHandle & { readonly closeCalls: () => number } {
  let transport: Transport | undefined;
  let closeCalls = 0;

  return {
    connect: async (nextTransport) => {
      transport = nextTransport;
      if (options.connectError) {
        throw options.connectError;
      }
    },
    close: async () => {
      closeCalls += 1;
      if (options.closeError) {
        throw options.closeError;
      }
      if (options.closeTransport !== false) {
        await transport?.close();
      }
    },
    listTools: async () => {
      if (options.listToolsError) {
        throw options.listToolsError;
      }
      return { tools: [] };
    },
    callTool: async () => {
      throw new Error("callTool is not implemented by this test stub");
    },
    closeCalls: () => closeCalls,
  };
}

describe("McpClient connection cleanup", () => {
  test("closes the MCP transport when client.connect fails", async () => {
    const connectError = new Error("connect failed");
    const sdkClient = createConnectableStubClient({ connectError });
    const transport = createTransportStub();
    const client = new McpClient(
      {
        name: "filesystem",
        transport: "stdio",
        command: "mcp-server-filesystem",
      },
      {
        client: sdkClient,
        createTransport: () => transport,
      },
    );

    await expect(client.connect()).rejects.toBe(connectError);

    expect(sdkClient.closeCalls()).toBe(1);
    expect(transport.closeCalls()).toBe(1);
  });

  test("closes the MCP transport when initial tool discovery fails", async () => {
    const listToolsError = new Error("tools/list failed");
    const sdkClient = createConnectableStubClient({ listToolsError });
    const transport = createTransportStub();
    const client = new McpClient(
      {
        name: "search-server",
        transport: "sse",
        url: "https://example.test/mcp",
      },
      {
        client: sdkClient,
        createTransport: () => transport,
      },
    );

    await expect(client.connect()).rejects.toBe(listToolsError);

    expect(sdkClient.closeCalls()).toBe(1);
    expect(transport.closeCalls()).toBe(1);
  });

  test("falls back to closing the transport directly if the client cleanup does not close it", async () => {
    const connectError = new Error("connect failed");
    const sdkClient = createConnectableStubClient({
      connectError,
      closeTransport: false,
    });
    const transport = createTransportStub();
    const client = new McpClient(
      {
        name: "filesystem",
        transport: "stdio",
        command: "mcp-server-filesystem",
      },
      {
        client: sdkClient,
        createTransport: () => transport,
      },
    );

    await expect(client.connect()).rejects.toBe(connectError);

    expect(sdkClient.closeCalls()).toBe(1);
    expect(transport.closeCalls()).toBe(1);
  });

  test("reports cleanup failures without masking the original connection error", async () => {
    const connectError = new Error("connect failed");
    const closeError = new Error("cleanup failed");
    const sdkClient = createConnectableStubClient({ connectError, closeError });
    const transport = createTransportStub();
    const serverName = "filesystem-cleanup-error";
    const observedErrors: Array<{
      readonly component?: string;
      readonly error?: string;
      readonly context?: Record<string, unknown>;
    }> = [];
    const unsubscribe = Bus.observe((event, payload) => {
      const errorPayload = payload as {
        readonly component?: string;
        readonly error?: string;
        readonly context?: Record<string, unknown>;
      };
      if (
        event.name === Operational.Error.name &&
        errorPayload.component === "agent.mcp" &&
        errorPayload.context?.serverName === serverName
      ) {
        observedErrors.push(errorPayload);
      }
    });
    const client = new McpClient(
      {
        name: serverName,
        transport: "stdio",
        command: "mcp-server-filesystem",
      },
      {
        client: sdkClient,
        createTransport: () => transport,
      },
    );

    try {
      await expect(client.connect()).rejects.toBe(connectError);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      unsubscribe();
    }

    expect(sdkClient.closeCalls()).toBe(1);
    expect(transport.closeCalls()).toBe(1);
    expect(observedErrors).toHaveLength(1);
    expect(observedErrors[0]?.component).toBe("agent.mcp");
    expect(observedErrors[0]?.error).toBe("Error: connect failed");
    expect(observedErrors[0]?.context?.cleanupError).toBe("Error: cleanup failed");
  });

  test("reports transport factory failures through operational errors", async () => {
    const createError = new Error("transport factory failed");
    const serverName = "factory-failure";
    const observedErrors: Array<{
      readonly component?: string;
      readonly error?: string;
      readonly context?: Record<string, unknown>;
    }> = [];
    const unsubscribe = Bus.observe((event, payload) => {
      const errorPayload = payload as {
        readonly component?: string;
        readonly error?: string;
        readonly context?: Record<string, unknown>;
      };
      if (
        event.name === Operational.Error.name &&
        errorPayload.component === "agent.mcp" &&
        errorPayload.context?.serverName === serverName
      ) {
        observedErrors.push(errorPayload);
      }
    });
    const client = new McpClient(
      {
        name: serverName,
        transport: "stdio",
        command: "mcp-server-filesystem",
      },
      {
        client: createStubClient([]),
        createTransport: () => {
          throw createError;
        },
      },
    );

    try {
      await expect(client.connect()).rejects.toBe(createError);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      unsubscribe();
    }

    expect(observedErrors).toHaveLength(1);
    expect(observedErrors[0]?.component).toBe("agent.mcp");
    expect(observedErrors[0]?.error).toBe("Error: transport factory failed");
    expect(observedErrors[0]?.context?.serverName).toBe(serverName);
    expect(observedErrors[0]?.context?.cleanupError).toBeUndefined();
  });

  test("preserves the explicit error for unknown runtime transports", async () => {
    const serverName = "invalid-transport";
    const observedErrors: Array<{
      readonly component?: string;
      readonly error?: string;
      readonly context?: Record<string, unknown>;
    }> = [];
    const unsubscribe = Bus.observe((event, payload) => {
      const errorPayload = payload as {
        readonly component?: string;
        readonly error?: string;
        readonly context?: Record<string, unknown>;
      };
      if (
        event.name === Operational.Error.name &&
        errorPayload.component === "agent.mcp" &&
        errorPayload.context?.serverName === serverName
      ) {
        observedErrors.push(errorPayload);
      }
    });
    const client = new McpClient({
      name: serverName,
      transport: "invalid",
      command: "mcp-server-filesystem",
    } as never);

    try {
      await expect(client.connect()).rejects.toThrow("Unknown transport");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      unsubscribe();
    }

    expect(observedErrors).toHaveLength(1);
    expect(observedErrors[0]?.component).toBe("agent.mcp");
    expect(observedErrors[0]?.error).toBe("Error: Unknown transport");
    expect(observedErrors[0]?.context?.serverName).toBe(serverName);
    expect(observedErrors[0]?.context?.cleanupError).toBeUndefined();
  });

  test("does not double-close when the client closes a transport that omits onclose", async () => {
    const connectError = new Error("connect failed");
    const sdkClient = createConnectableStubClient({ connectError });
    const transport = createTransportStub({ emitOnClose: false });
    const client = new McpClient(
      {
        name: "filesystem",
        transport: "stdio",
        command: "mcp-server-filesystem",
      },
      {
        client: sdkClient,
        createTransport: () => transport,
      },
    );

    await expect(client.connect()).rejects.toBe(connectError);

    expect(sdkClient.closeCalls()).toBe(1);
    expect(transport.closeCalls()).toBe(1);
  });
});

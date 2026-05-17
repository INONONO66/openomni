import { describe, expect, test } from "bun:test";
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

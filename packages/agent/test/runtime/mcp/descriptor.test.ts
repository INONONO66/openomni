import { describe, expect, test } from "bun:test";
import type { RuntimeResource, Tool } from "@openomni/protocol";
import { McpClient } from "../../../src/runtime/mcp/client";

interface McpToolStub {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

interface ListToolsClientStub {
  listTools(): Promise<{ tools: McpToolStub[] }>;
}

interface McpClientInternals {
  client: ListToolsClientStub;
}

type ToolSpecWithDescriptor = Tool.Spec & {
  readonly descriptor?: RuntimeResource.Descriptor;
};

function stubListTools(client: McpClient, tools: McpToolStub[]): void {
  const internals = client as unknown as McpClientInternals;
  internals.client = {
    listTools: async () => ({ tools }),
  };
}

describe("McpClient tool descriptors", () => {
  test("attaches RuntimeResource descriptors to listed MCP tools", async () => {
    const client = new McpClient({
      name: "filesystem",
      transport: "stdio",
      command: "mcp-server-filesystem",
    });
    stubListTools(client, [
      {
        name: "write_file",
        description: "Write a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);

    const [tool] = (await client.listTools()) as ToolSpecWithDescriptor[];

    expect(tool?.name).toBe("filesystem.write_file");
    expect(tool?.labels).toEqual(["source.mcp", "mcp.filesystem"]);
    expect(tool?.descriptor).toEqual({
      id: "tool:mcp:write_file",
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
    const client = new McpClient({
      name: "search-server",
      transport: "sse",
      url: "https://example.test/mcp",
    });
    stubListTools(client, [{ name: "search" }]);

    const [tool] = (await client.listTools()) as ToolSpecWithDescriptor[];

    expect(tool?.name).toBe("search-server.search");
    expect(tool?.descriptor?.id).toBe("tool:mcp:search");
    expect(tool?.descriptor?.source).toEqual({
      type: "mcp",
      serverId: "search-server",
      remoteName: "search",
    });
  });
});

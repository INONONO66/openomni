import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@openomni/protocol";
import type { McpServerConfig } from "./types";
import { convertMcpTool, convertMcpResult } from "./convert";

export class McpClient {
  private client: Client;
  private config: McpServerConfig;
  private connected = false;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.client = new Client({ name: "openomni-agent", version: "0.1.0" });
  }

  async connect(): Promise<void> {
    const transport = createTransport(this.config);
    await this.client.connect(transport);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  async listTools(): Promise<Tool.Spec[]> {
    const response = await this.client.listTools();
    return response.tools.map((t) => convertMcpTool(t, this.config.name));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
  ): Promise<Tool.Result> {
    const strippedName = name.startsWith(`${this.config.name}.`)
      ? name.slice(this.config.name.length + 1)
      : name;

    const response = await this.client.callTool({
      name: strippedName,
      arguments: args,
    });

    return convertMcpResult(
      response as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      },
      toolCallId,
    );
  }

  get serverName(): string {
    return this.config.name;
  }
}

function createTransport(config: McpServerConfig) {
  switch (config.transport) {
    case "stdio": {
      if (!config.command) throw new Error("stdio transport requires command");
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
      });
    }
    case "sse": {
      if (!config.url) throw new Error("sse transport requires url");
      return new SSEClientTransport(new URL(config.url));
    }
    case "streamable-http": {
      if (!config.url)
        throw new Error("streamable-http transport requires url");
      return new StreamableHTTPClientTransport(new URL(config.url));
    }
    default:
      throw new Error(`Unknown transport: ${String(config.transport)}`);
  }
}

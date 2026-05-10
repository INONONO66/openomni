import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";
import type { McpServerConfig, Tool } from "@openomni/protocol";
import { Mcp, Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
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
    const traceId = randomUUID();
    const transport = createTransport(this.config);
    const transportType =
      this.config.transport === "streamable-http"
        ? ("streamable-http" as const)
        : (this.config.transport as "stdio" | "sse" | "http");

    try {
      await this.client.connect(transport);
      const tools = await this.client.listTools();
      this.connected = true;

      const toolCount = tools.tools.length;

      Bus.publish(Mcp.Connected, {
        traceId,
        serverName: this.config.name,
        transport: transportType,
        toolCount,
        time: Date.now(),
      });
    } catch (err) {
      this.connected = false;
      Bus.publish(Operational.Error, {
        traceId,
        time: Date.now(),
        component: "agent.mcp",
        msg: "MCP connection failed",
        error: String(err),
        context: { serverName: this.config.name },
      });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      const traceId = randomUUID();

      try {
        await this.client.close();
        this.connected = false;

        Bus.publish(Mcp.Disconnected, {
          traceId,
          serverName: this.config.name,
          time: Date.now(),
        });
      } catch (err) {
        Bus.publish(Operational.Error, {
          traceId,
          time: Date.now(),
          component: "agent.mcp",
          msg: "MCP disconnection failed",
          error: String(err),
          context: { serverName: this.config.name },
        });
        throw err;
      }
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
    const traceId = randomUUID();
    const strippedName = name.startsWith(`${this.config.name}.`)
      ? name.slice(this.config.name.length + 1)
      : name;

    const startTime = Date.now();

    Bus.publish(Mcp.ToolCalled, {
      traceId,
      serverName: this.config.name,
      toolName: strippedName,
      toolCallId,
      time: startTime,
    });

    try {
      const response = await this.client.callTool({
        name: strippedName,
        arguments: args,
      });

      const _durationMs = Date.now() - startTime;

      return convertMcpResult(
        response as {
          content: Array<{ type: string; text?: string }>;
          isError?: boolean;
        },
        toolCallId,
      );
    } catch (err) {
      const _durationMs = Date.now() - startTime;

      Bus.publish(Mcp.ToolFailed, {
        traceId,
        serverName: this.config.name,
        toolName: strippedName,
        toolCallId,
        error: String(err),
        time: Date.now(),
      });

      throw err;
    }
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
      if (!config.url) throw new Error("streamable-http transport requires url");
      return new StreamableHTTPClientTransport(new URL(config.url));
    }
    default:
      throw new Error(`Unknown transport: ${String(config.transport)}`);
  }
}

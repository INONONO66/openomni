import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { randomUUID } from "node:crypto";
import type { McpServerConfig, Tool } from "@openomni/protocol";
import { Mcp, Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import {
  cleanupFailedConnection,
  type TransportCloseTracker,
  trackTransportCloseRequests,
} from "./client-connection";
import { attachMcpToolDescriptor } from "./client-descriptor";
import { createTransport } from "./client-transport";
import type { McpClientDependencies, McpClientHandle, McpTransportFactory } from "./client-types";
import { convertMcpTool, convertMcpResult } from "./convert";

export type {
  McpClientDependencies,
  McpClientHandle,
  McpTransportFactory,
} from "./client-types";

export class McpClient {
  private client: McpClientHandle;
  private config: McpServerConfig;
  private createTransport: McpTransportFactory;
  private connected = false;

  constructor(config: McpServerConfig, dependencies: McpClientDependencies = {}) {
    this.config = config;
    this.client = dependencies.client ?? new Client({ name: "openomni-agent", version: "0.1.0" });
    this.createTransport = dependencies.createTransport ?? createTransport;
  }

  async connect(): Promise<void> {
    const traceId = randomUUID();
    let transport: Transport | undefined;
    let closeTracker: TransportCloseTracker | undefined;
    const transportType =
      this.config.transport === "streamable-http"
        ? ("streamable-http" as const)
        : (this.config.transport as "stdio" | "sse" | "http");

    try {
      transport = this.createTransport(this.config);
      closeTracker = trackTransportCloseRequests(transport);
      await this.client.connect(transport);
      const tools = await this.client.listTools(undefined, requestOptions(this.config));
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
      const cleanupError = transport
        ? await cleanupFailedConnection(this.client, transport, closeTracker)
        : undefined;
      const context: Record<string, unknown> = { serverName: this.config.name };
      if (cleanupError) {
        context.cleanupError = String(cleanupError);
      }

      Bus.publish(Operational.Error, {
        traceId,
        time: Date.now(),
        component: "agent.mcp",
        msg: "MCP connection failed",
        error: String(err),
        context,
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

  async listTools(context?: { readonly signal?: AbortSignal }): Promise<Tool.Spec[]> {
    const response = await this.client.listTools(undefined, requestOptions(this.config, context));
    return response.tools.map((tool) =>
      attachMcpToolDescriptor(convertMcpTool(tool, this.config.name), this.config.name, tool.name),
    );
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
    context?: Tool.ExecutionContext,
  ): Promise<Tool.Result> {
    const traceId = context?.traceContext?.traceId ?? randomUUID();
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
      const response = await this.client.callTool(
        {
          name: strippedName,
          arguments: args,
        },
        undefined,
        requestOptions(this.config, context),
      );

      return convertMcpResult(
        response as {
          content: Array<{ type: string; text?: string }>;
          isError?: boolean;
        },
        toolCallId,
      );
    } catch (err) {
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

export function requestOptions(
  config: McpServerConfig,
  context?: { readonly signal?: AbortSignal },
): RequestOptions | undefined {
  const timeout = normalizeTimeout(config.timeout);
  if (context?.signal === undefined && timeout === undefined) {
    return undefined;
  }

  return {
    ...(context?.signal !== undefined && { signal: context.signal }),
    ...(timeout !== undefined && { timeout, maxTotalTimeout: timeout }),
  };
}

function normalizeTimeout(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  return Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
}

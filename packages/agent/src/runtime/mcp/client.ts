import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { BusEvent, McpServerConfig, Tool } from "@openomni/protocol";
import { Mcp, Operational } from "@openomni/protocol";
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
  private readonly lifecycleTraceId: string | undefined;
  private readonly events: BusEvent.Sink;
  private connected = false;

  constructor(config: McpServerConfig, dependencies: McpClientDependencies) {
    this.config = config;
    this.client = dependencies.client ?? new Client({ name: "openomni-agent", version: "0.1.0" });
    this.createTransport = dependencies.createTransport ?? createTransport;
    this.lifecycleTraceId = dependencies.traceId;
    this.events = dependencies.events;
  }

  /**
   * Publishes a server-lifecycle record, or nothing.
   *
   * The trace is whatever brought this server up. Absent, there is no run and
   * no boot to attribute the record to, and a minted id would name neither —
   * so the record is dropped rather than filed under a fiction.
   */
  private publishLifecycle<T extends { traceId: string }>(
    descriptor: BusEvent.Descriptor<T>,
    payload: Omit<T, "traceId">,
  ): void {
    const traceId = this.lifecycleTraceId;
    if (traceId === undefined || traceId.length === 0) return;
    this.events.publish(descriptor, { ...payload, traceId } as T);
  }

  async connect(): Promise<void> {
    // Idempotent (#audit L5): a second connect() on a live client created a
    // second transport the first one never closed — the SDK client rebinds
    // and the old transport leaks its process/socket.
    if (this.connected) return;
    let transport: Transport | undefined;
    let closeTracker: TransportCloseTracker | undefined;
    const transportType = this.config.transport;

    try {
      transport = this.createTransport(this.config);
      closeTracker = trackTransportCloseRequests(transport);
      await this.client.connect(transport);
      const tools = await this.client.listTools(undefined, requestOptions(this.config));
      this.connected = true;

      const toolCount = tools.tools.length;

      this.publishLifecycle(Mcp.Events.Connected, {
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

      this.publishLifecycle(Operational.Events.Error, {
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
      try {
        await this.client.close();
        this.connected = false;

        this.publishLifecycle(Mcp.Events.Disconnected, {
          serverName: this.config.name,
          time: Date.now(),
        });
      } catch (err) {
        this.publishLifecycle(Operational.Events.Error, {
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
    // The executor that dispatches this refuses a call with no trace, so
    // there is one; a caller reaching past it is refused here.
    const traceId = context?.traceContext?.traceId;
    if (traceId === undefined || traceId.length === 0) {
      throw new Error("mcp tool call requires the run trace context");
    }
    const strippedName = name.startsWith(`${this.config.name}.`)
      ? name.slice(this.config.name.length + 1)
      : name;

    const startTime = Date.now();

    this.events.publish(Mcp.Events.ToolCalled, {
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
      this.events.publish(Mcp.Events.ToolFailed, {
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

function requestOptions(
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

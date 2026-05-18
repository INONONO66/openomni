import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { randomUUID } from "node:crypto";
import type { McpServerConfig, RuntimeResource, Tool } from "@openomni/protocol";
import { Mcp, Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { convertMcpTool, convertMcpResult } from "./convert";

/** @internal Test-oriented seam for replacing the underlying MCP SDK client. */
export type McpClientHandle = Pick<Client, "connect" | "close" | "listTools" | "callTool">;
/** @internal Test-oriented seam for replacing the underlying MCP transport factory. */
export type McpTransportFactory = (config: McpServerConfig) => Transport;

/** @internal Constructor dependencies are intended for tests and package-internal adapters. */
export interface McpClientDependencies {
  readonly client?: McpClientHandle;
  readonly createTransport?: McpTransportFactory;
}

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
    return response.tools.map((t) =>
      attachMcpToolDescriptor(convertMcpTool(t, this.config.name), this.config.name, t.name),
    );
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
    context?: { readonly signal?: AbortSignal },
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
      const response = await this.client.callTool(
        {
          name: strippedName,
          arguments: args,
        },
        undefined,
        requestOptions(this.config, context),
      );

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

interface TransportCloseTracker {
  readonly isClosed: () => boolean;
}

function trackTransportCloseRequests(transport: Transport): TransportCloseTracker {
  let closeRequested = false;
  const close = transport.close.bind(transport);
  // Wrap this freshly created transport so cleanup can tell whether the SDK
  // client actually attempted to close it, independent of onclose callback timing.
  transport.close = async () => {
    closeRequested = true;
    await close();
  };

  return {
    isClosed: () => closeRequested,
  };
}

async function cleanupFailedConnection(
  client: McpClientHandle,
  transport: Transport,
  closeTracker?: TransportCloseTracker,
): Promise<unknown | undefined> {
  let cleanupError: unknown;
  try {
    await client.close();
  } catch (err) {
    cleanupError = err;
  }

  // The SDK client normally owns and closes the transport after connect() starts.
  // If close() failed before it reached the transport, close it directly while
  // still preserving the original connection error for callers.
  if (!closeTracker?.isClosed()) {
    try {
      await transport.close();
    } catch (err) {
      cleanupError ??= err;
    }
  }

  return cleanupError;
}

type McpToolSpec = Tool.Spec & {
  readonly descriptor: RuntimeResource.Descriptor;
};

function createMcpToolDescriptor(serverId: string, remoteName: string): RuntimeResource.Descriptor {
  return {
    id: `tool:mcp:${serverId}:${remoteName}`,
    kind: "tool",
    source: {
      type: "mcp",
      serverId,
      remoteName,
    },
    labels: ["source.mcp", `mcp.${serverId}`],
    capabilities: ["network.write"],
    effects: ["external.write"],
  };
}

function attachMcpToolDescriptor(
  spec: Tool.Spec,
  serverId: string,
  remoteName: string,
): McpToolSpec {
  const descriptor = createMcpToolDescriptor(serverId, remoteName);

  return {
    ...spec,
    labels: descriptor.labels,
    descriptor,
  };
}

const DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS = {
  initialReconnectionDelay: 1_000,
  maxReconnectionDelay: 30_000,
  reconnectionDelayGrowFactor: 1.5,
} as const;

function createTransport(config: McpServerConfig): Transport {
  switch (config.transport) {
    case "stdio":
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
      });
    case "sse":
      return new SSEClientTransport(new URL(config.url), sseTransportOptions(config));
    case "streamable-http":
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        streamableHttpTransportOptions(config),
      );
    default:
      throw new Error("Unknown transport");
  }
}

function sseTransportOptions(config: McpServerConfig): SSEClientTransportOptions | undefined {
  const headers = config.headers;
  if (headers === undefined) return undefined;

  // The SSE SDK transport exposes header injection but not a retry option; only
  // streamable-http can apply `config.retries` below.
  return {
    requestInit: { headers: { ...headers } },
    eventSourceInit: { fetch: createSseHeaderFetch(headers) },
  };
}

function streamableHttpTransportOptions(
  config: McpServerConfig,
): StreamableHTTPClientTransportOptions | undefined {
  const requestInit = requestInitForHeaders(config);
  const maxRetries = normalizeRetries(config.retries);
  if (requestInit === undefined && maxRetries === undefined) return undefined;

  return {
    ...(requestInit !== undefined && { requestInit }),
    ...(maxRetries !== undefined && {
      reconnectionOptions: {
        ...DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS,
        maxRetries,
      },
    }),
  };
}

function requestInitForHeaders(config: McpServerConfig): RequestInit | undefined {
  if (config.headers === undefined) return undefined;
  return { headers: { ...config.headers } };
}

type SseEventSourceFetch = NonNullable<
  NonNullable<SSEClientTransportOptions["eventSourceInit"]>["fetch"]
>;
type FetchRequestInit = NonNullable<Parameters<typeof fetch>[1]>;

function createSseHeaderFetch(headers: Record<string, string>): SseEventSourceFetch {
  const headerSnapshot = { ...headers };
  return ((url: string | URL, init?: Parameters<SseEventSourceFetch>[1]) => {
    const mergedHeaders = new Headers(init?.headers as FetchRequestInit["headers"] | undefined);
    for (const [name, value] of Object.entries(headerSnapshot)) {
      mergedHeaders.set(name, value);
    }

    return fetch(url, { ...init, headers: mergedHeaders });
  }) as SseEventSourceFetch;
}

function normalizeRetries(retries: number | undefined): number | undefined {
  if (retries === undefined) return undefined;
  return Number.isFinite(retries) && retries >= 0 ? Math.trunc(retries) : undefined;
}

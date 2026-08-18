import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConfig } from "@openomni/protocol";

const DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS = {
  initialReconnectionDelay: 1_000,
  maxReconnectionDelay: 30_000,
  reconnectionDelayGrowFactor: 1.5,
} as const;

export function createTransport(config: McpConfig.ServerConfig): Transport {
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

function sseTransportOptions(
  config: McpConfig.ServerConfig,
): SSEClientTransportOptions | undefined {
  const headers = config.headers;
  if (headers === undefined) return undefined;

  return {
    requestInit: { headers: { ...headers } },
    eventSourceInit: { fetch: createSseHeaderFetch(headers) },
  };
}

function streamableHttpTransportOptions(
  config: McpConfig.ServerConfig,
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

function requestInitForHeaders(config: McpConfig.ServerConfig): RequestInit | undefined {
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

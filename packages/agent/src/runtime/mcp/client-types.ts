import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { BusEvent, McpServerConfig } from "@openomni/protocol";

export type McpClientHandle = Pick<Client, "connect" | "close" | "listTools" | "callTool">;

export type McpTransportFactory = (config: McpServerConfig) => Transport;

export interface McpClientDependencies {
  readonly client?: McpClientHandle;
  readonly createTransport?: McpTransportFactory;
  /**
   * The trace connect/disconnect are reported under. An MCP server's lifecycle
   * belongs to whatever brought it up — the boot, by way of `McpToolProvider`
   * — and never to a run. Absent, the lifecycle records are not published:
   * observation does not get to invent an identity for itself.
   */
  readonly traceId?: string;
  /** Where this client's records go. Supplied by whatever created it. */
  readonly events: BusEvent.Sink;
}

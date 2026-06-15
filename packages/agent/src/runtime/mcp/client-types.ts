import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "@openomni/protocol";

export type McpClientHandle = Pick<Client, "connect" | "close" | "listTools" | "callTool">;

export type McpTransportFactory = (config: McpServerConfig) => Transport;

export interface McpClientDependencies {
  readonly client?: McpClientHandle;
  readonly createTransport?: McpTransportFactory;
}

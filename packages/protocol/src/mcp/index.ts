import { z } from "zod";

export namespace McpConfig {
  export const ServerConfig = z.object({
    name: z.string(),
    transport: z.enum(["stdio", "sse", "streamable-http"]),
    command: z.string().optional(),
    args: z.string().array().optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Per-request timeout in milliseconds for MCP tool discovery and tool calls. */
    timeout: z.number().optional(),
    retries: z.number().optional(),
  });
  export type ServerConfig = z.infer<typeof ServerConfig>;
}

export const McpServerConfig = McpConfig.ServerConfig;
export type McpServerConfig = McpConfig.ServerConfig;

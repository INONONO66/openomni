import { z } from "zod";

export namespace McpConfig {
  const BaseServerConfig = z.object({
    name: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Per-request timeout in milliseconds for MCP tool discovery and tool calls. */
    timeout: z.number().int().nonnegative().optional(),
    retries: z.number().int().nonnegative().optional(),
  });

  export const StdioServerConfig = BaseServerConfig.extend({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.string().array().optional(),
  });
  export type StdioServerConfig = z.infer<typeof StdioServerConfig>;

  export const SseServerConfig = BaseServerConfig.extend({
    transport: z.literal("sse"),
    url: z.string().url(),
  });
  export type SseServerConfig = z.infer<typeof SseServerConfig>;

  export const StreamableHttpServerConfig = BaseServerConfig.extend({
    transport: z.literal("streamable-http"),
    url: z.string().url(),
  });
  export type StreamableHttpServerConfig = z.infer<typeof StreamableHttpServerConfig>;

  export const ServerConfig = z.discriminatedUnion("transport", [
    StdioServerConfig,
    SseServerConfig,
    StreamableHttpServerConfig,
  ]);
  export type ServerConfig = z.infer<typeof ServerConfig>;
}

export const McpServerConfig = McpConfig.ServerConfig;
export type McpServerConfig = McpConfig.ServerConfig;

import type { McpConfig, Tool } from "@openomni/protocol";
import type { ToolExecutionContext } from "@openomni/openomni";

/** @internal Package-local injected client seam for McpToolProvider tests/options. */
export interface McpClientLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<Tool.Spec[]>;
  callTool(
    toolName: string,
    input: Record<string, unknown>,
    callId?: string,
    context?: ToolExecutionContext,
  ): Promise<Tool.Result>;
}

export interface McpToolProviderOptions {
  readonly createClient?: (config: McpConfig.ServerConfig) => McpClientLike;
  /**
   * The trace of the boot that created this provider. Connect failures are
   * reported under it — boot is a trace origin, an MCP connect is not.
   */
  readonly traceId: string;
}

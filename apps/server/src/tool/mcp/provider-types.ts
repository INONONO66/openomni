import type { McpServerConfig, Tool } from "@openomni/protocol";
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
  readonly createClient?: (config: McpServerConfig) => McpClientLike;
  /** The boot trace this provider reports connect failures under. */
  readonly traceId?: string;
}

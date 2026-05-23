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
}

export interface McpLifecycleAuditContext {
  readonly audit?: {
    readonly sessionId?: string;
  };
  readonly actor?: Record<string, unknown>;
}

/** @internal Package-local helper for McpToolProvider lifecycle audit. */
export type ResolvedLifecycleAudit = {
  readonly sessionId: string;
  readonly actor?: Record<string, unknown>;
};

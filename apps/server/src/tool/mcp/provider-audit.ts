import type { Tool } from "@openomni/protocol";

/** @internal Package-local helper for McpToolProvider only. */
export const MCP_TOOL_ACTION = "mcp.tool.call";

/** @internal Package-local helper for McpToolProvider only. */
export function readSessionId(call: Tool.Call): string | undefined {
  const sessionId = call.input.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/** @internal Package-local helper for McpToolProvider only. */
export function buildActor(
  sessionId: string | undefined,
  actor: Record<string, unknown> | undefined = undefined,
): Record<string, unknown> {
  return {
    ...(actor ?? {}),
    kind: "mcp_provider",
    ...(sessionId !== undefined && { sessionId }),
  };
}

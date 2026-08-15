/** @internal Package-local helper for McpToolProvider only. */
export const MCP_TOOL_ACTION = "mcp.tool.call";

/** @internal Package-local helper for McpToolProvider only. */
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

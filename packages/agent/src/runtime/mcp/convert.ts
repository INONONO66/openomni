import type { Tool } from "@openomni/protocol";

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export function convertMcpTool(mcpTool: McpTool, serverName?: string): Tool.Spec {
  const toolName = serverName ? `${serverName}.${mcpTool.name}` : mcpTool.name;
  return {
    name: toolName,
    description: mcpTool.description,
    inputSchema: mcpTool.inputSchema ?? { type: "object", properties: {} },
  };
}

export function convertMcpResult(mcpResult: McpToolResult, toolCallId: string): Tool.Result {
  const text = mcpResult.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

  return {
    id: crypto.randomUUID(),
    toolCallId,
    output: text,
    isError: mcpResult.isError ?? false,
  };
}

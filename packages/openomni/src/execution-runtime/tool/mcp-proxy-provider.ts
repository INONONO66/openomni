import type { Tool } from "@openomni/protocol";
import type { WorkerBootstrap } from "@openomni/protocol";
import type { NativeTool } from "./types.js";

type RuntimeToolCatalogEntry = WorkerBootstrap.RuntimeToolCatalogEntry;

export namespace McpProxyToolProvider {
  export function create(
    entries: RuntimeToolCatalogEntry[],
    callTool: (toolName: string, args: Record<string, unknown>) => Promise<Tool.Result>,
  ): { listTools(): NativeTool[] } {
    const mcpTools: NativeTool[] = entries
      .filter((entry) => entry.source === "mcp")
      .map((entry) => ({
        spec: entry.spec,
        riskTier: entry.riskTier,
        isReadOnly: false,
        isDestructive: false,
        isConcurrencySafe: false,
        source: "mcp" as const,
        execute: (call: Tool.Call): Promise<Tool.Result> =>
          callTool(entry.canonicalName, call.input as Record<string, unknown>),
      }));

    return {
      listTools: () => mcpTools,
    };
  }
}

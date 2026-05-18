import type { Tool } from "@openomni/protocol";
import type { WorkerBootstrap } from "@openomni/protocol";
import type { NativeTool, ToolExecutionContext } from "./types.js";

type RuntimeToolCatalogEntry = WorkerBootstrap.RuntimeToolCatalogEntry;

export namespace ToolProxyProvider {
  export function create(
    entries: RuntimeToolCatalogEntry[],
    callTool: (
      toolName: string,
      args: Record<string, unknown>,
      context?: ToolExecutionContext,
    ) => Promise<Tool.Result>,
  ): { listTools(): NativeTool[] } {
    const tools: NativeTool[] = entries.map((entry) => ({
      spec: entry.spec,
      riskTier: entry.riskTier,
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      labels: entry.spec.labels,
      ...(entry.descriptor !== undefined && { descriptor: entry.descriptor }),
      source: entry.source,
      execute: (call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result> =>
        context === undefined
          ? callTool(entry.canonicalName, call.input as Record<string, unknown>)
          : callTool(entry.canonicalName, call.input as Record<string, unknown>, context),
    }));

    return {
      listTools: () => tools,
    };
  }
}

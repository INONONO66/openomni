import type { Tool } from "@openomni/protocol";
import type { NativeTool, ToolExecutionContext } from "./types.js";

export namespace ToolProxyProvider {
  export function create(
    entries: readonly Tool.Spec[],
    callTool: (
      toolName: string,
      args: Record<string, unknown>,
      context?: ToolExecutionContext,
    ) => Promise<Tool.Result>,
  ): { listTools(): NativeTool[] } {
    const tools: NativeTool[] = entries.map((entry) => ({
      spec: entry,
      riskTier: entry.safe === true ? 0 : 2,
      isReadOnly: entry.safe === true,
      isDestructive: false,
      isConcurrencySafe: false,
      labels: entry.labels,
      execute: (call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result> =>
        context === undefined
          ? callTool(entry.name, call.input as Record<string, unknown>)
          : callTool(entry.name, call.input as Record<string, unknown>, context),
    }));

    return {
      listTools: () => tools,
    };
  }
}

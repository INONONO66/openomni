import { SubagentTool } from "@openomni/agent";
import type { SubagentToolOptions } from "@openomni/agent";
import type { NativeTool } from "../../types.js";
import { createSubagentRuntime } from "./subagent-runtime.js";

export function createSubagentTool(options?: SubagentToolOptions): NativeTool {
  const resolved: SubagentToolOptions = options ?? {
    subagentRuntime: createSubagentRuntime(),
  };
  const tool = SubagentTool.create(resolved);
  return {
    spec: tool.spec,
    riskTier: 1,
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    source: "agent",
    async execute(call) {
      const result = await tool.execute(call.input);
      return { ...result, toolCallId: call.id };
    },
  };
}

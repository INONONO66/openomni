import { SubagentTool } from "@openomni/agent";
import type { NativeTool } from "../../types.js";
import { createSubagentRuntime } from "./subagent-runtime.js";

export function createSubagentTool(): NativeTool {
  const tool = SubagentTool.create({
    subagentRuntime: createSubagentRuntime(),
  });
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

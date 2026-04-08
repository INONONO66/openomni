import { SubagentTool } from "@openomni/agent";
import type { NativeTool } from "../../types";

export function createSubagentTool(): NativeTool {
  const tool = SubagentTool.create();
  return {
    spec: tool.spec,
    riskTier: 1,
    async execute(call) {
      const result = await tool.execute(call.input);
      return { ...result, toolCallId: call.id };
    },
  };
}

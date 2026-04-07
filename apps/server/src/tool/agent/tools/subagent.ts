import { SubagentTool } from "@openomni/agent";
import type { NativeTool } from "../../types";

export function createSubagentTool(): NativeTool {
  const tool = SubagentTool.create();
  return {
    spec: tool.spec,
    riskTier: 1,
    execute(call) {
      return tool.execute(call.input);
    },
  };
}

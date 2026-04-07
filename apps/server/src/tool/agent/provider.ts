import type { Tool } from "@openomni/protocol";
import type { NativeTool, ToolCategory, ToolProvider } from "../types";
import { notificationTool } from "./tools/notification";
import { createSubagentTool } from "./tools/subagent";
import { stubTools } from "./tools/stubs";

export class AgentToolProvider implements ToolProvider {
  readonly name = "agent";
  readonly category: ToolCategory = "agent";

  listTools(): NativeTool[] {
    return [createSubagentTool(), notificationTool, ...stubTools];
  }

  execute(call: Tool.Call): Promise<Tool.Result> {
    const tool = this.listTools().find((t) => t.spec.name === call.tool);
    if (!tool) {
      return Promise.resolve({
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `Unknown tool: ${call.tool}`,
        isError: true,
      });
    }
    return tool.execute(call);
  }
}

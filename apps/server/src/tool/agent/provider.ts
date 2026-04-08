import type { Tool } from "@openomni/protocol";
import type { NativeTool, ToolCategory, ToolProvider } from "../types";
import { notificationTool } from "./tools/notification";
import { createSubagentTool } from "./tools/subagent";

export class AgentToolProvider implements ToolProvider {
  readonly name = "agent";
  readonly category: ToolCategory = "agent";

  private extraTools: NativeTool[] = [];

  register(tool: NativeTool): void {
    this.extraTools.push(tool);
  }

  listTools(): NativeTool[] {
    return [createSubagentTool(), notificationTool, ...this.extraTools];
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

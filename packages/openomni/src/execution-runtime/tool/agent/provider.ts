import type { Tool } from "@openomni/protocol";
import type { NativeTool, ToolCategory, ToolProvider } from "../types.js";
import { createSubagentTool } from "./tools/subagent.js";

export class AgentToolProvider implements ToolProvider {
  readonly name = "agent";
  readonly category: ToolCategory = "agent";

  private extraTools: NativeTool[] = [];

  register(tool: NativeTool): void {
    this.extraTools.push(tool);
  }

  listTools(): NativeTool[] {
    return [createSubagentTool(), ...this.extraTools];
  }

  execute(call: Tool.Call): Promise<Tool.Result> {
    const tool = this.listTools().find(
      (entry) => entry.spec.name === call.tool || entry.spec.name === call.tool.replace(/_/g, "."),
    );
    if (!tool) {
      return Promise.resolve({
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `Unknown tool: ${call.tool}`,
        isError: true,
      });
    }
    return tool.execute({ ...call, tool: tool.spec.name });
  }
}

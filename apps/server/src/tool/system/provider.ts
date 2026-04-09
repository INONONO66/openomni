import type { Tool } from "@openomni/protocol";
import type { NativeTool, ToolCategory, ToolProvider } from "../types";
import { bashTool } from "../builtins/bash";
import { createEditTool } from "../builtins/edit";
import { createGlobTool } from "../builtins/glob";
import { createGrepTool } from "../builtins/grep";
import { createReadTool } from "../builtins/read";
import { createWriteTool } from "../builtins/write";

export class SystemToolProvider implements ToolProvider {
  readonly name = "system";
  readonly category: ToolCategory = "system";

  constructor(private readonly workspaceRoot?: string) {}

  listTools(): NativeTool[] {
    const tools: NativeTool[] = [bashTool(this.workspaceRoot)];
    if (this.workspaceRoot) {
      tools.push(
        createReadTool(this.workspaceRoot),
        createWriteTool(this.workspaceRoot),
        createEditTool(this.workspaceRoot),
        createGrepTool(this.workspaceRoot),
        createGlobTool(this.workspaceRoot),
      );
    }
    return tools;
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

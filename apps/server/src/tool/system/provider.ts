import type { Tool } from "@openomni/protocol";
import type { NativeTool, ToolCategory, ToolProvider } from "../types";
import { createEditTool } from "../builtins/edit";
import { createFilesystemTools } from "./tools/filesystem";
import { createGitTools } from "./tools/git";
import { createGlobTool } from "./tools/glob";
import { createShellTool } from "./tools/shell";

export class SystemToolProvider implements ToolProvider {
  readonly name = "system";
  readonly category: ToolCategory = "system";

  constructor(private readonly workspaceRoot?: string) {}

  listTools(): NativeTool[] {
    const tools: NativeTool[] = [];
    if (this.workspaceRoot) {
      tools.push(...createFilesystemTools(this.workspaceRoot));
      tools.push(createEditTool(this.workspaceRoot));
      tools.push(createGlobTool(this.workspaceRoot));
    }
    tools.push(createShellTool(this.workspaceRoot));
    if (this.workspaceRoot) {
      tools.push(...createGitTools(this.workspaceRoot));
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

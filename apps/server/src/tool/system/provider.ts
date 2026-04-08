import type { Tool } from "@openomni/protocol";
import type { NativeTool, ToolCategory, ToolProvider } from "../types";
import { filesystemTools } from "./tools/filesystem";
import { gitTools } from "./tools/git";
import { createShellTool } from "./tools/shell";

export class SystemToolProvider implements ToolProvider {
  readonly name = "system";
  readonly category: ToolCategory = "system";

  constructor(private readonly workspaceRoot?: string) {}

  listTools(): NativeTool[] {
    return [...filesystemTools, createShellTool(this.workspaceRoot), ...gitTools];
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

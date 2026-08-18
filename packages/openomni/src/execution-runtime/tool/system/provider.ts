import type { Tool } from "@openomni/protocol";
import type { NativeTool, ToolCategory, ToolExecutionContext, ToolProvider } from "../types.js";
import { bashTool } from "../builtins/bash.js";
import { createEditTool } from "../builtins/edit.js";
import { createGlobTool } from "../builtins/glob.js";
import { createGrepTool } from "../builtins/grep.js";
import { createReadTool } from "../builtins/read.js";
import { createRecallTool } from "../builtins/recall.js";
import { createWriteTool } from "../builtins/write.js";

export class SystemToolProvider implements ToolProvider {
  readonly name = "system";
  readonly category: ToolCategory = "system";

  constructor(private readonly workspaceRoot?: string) {}

  listTools(): NativeTool[] {
    // recall.output is session-scoped, not filesystem-scoped: it reads the
    // session store, so it does not gate on workspaceRoot.
    const tools: NativeTool[] = [bashTool(this.workspaceRoot), createRecallTool()];
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

  execute(call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result> {
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
    return context === undefined
      ? tool.execute({ ...call, tool: tool.spec.name })
      : tool.execute({ ...call, tool: tool.spec.name }, context);
  }
}

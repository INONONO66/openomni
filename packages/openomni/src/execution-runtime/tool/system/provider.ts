import type { Tool } from "@openomni/protocol";
import type { WorkspaceIdentity } from "../../workspace-identity.js";
import type { NativeTool, ToolCategory, ToolExecutionContext, ToolProvider } from "../types.js";
import { hasAcceptedToolEffect } from "../executor.js";
import { errorResult } from "../shared/result.js";
import { bashTool } from "../builtins/bash.js";
import { createEditTool } from "../builtins/edit.js";
import { createGlobTool } from "../builtins/glob.js";
import { createGrepTool } from "../builtins/grep.js";
import { createReadTool } from "../builtins/read.js";
import { createWriteTool } from "../builtins/write.js";

function requireAcceptedEffect(tool: NativeTool, workspace: WorkspaceIdentity): NativeTool {
  return {
    ...tool,
    execute(call, context) {
      if (!hasAcceptedToolEffect(context, tool.spec.name, workspace)) {
        return Promise.resolve(
          errorResult(call, `${tool.spec.name} requires an accepted pre-act effect intent`),
        );
      }
      return tool.execute(call, context);
    },
  };
}

export class SystemToolProvider implements ToolProvider {
  readonly name = "system";
  readonly category: ToolCategory = "system";

  constructor(private readonly workspace: WorkspaceIdentity) {}

  listTools(): NativeTool[] {
    const workspaceRoot = this.workspace.canonicalRoot;
    return [
      requireAcceptedEffect(bashTool(this.workspace), this.workspace),
      createReadTool(workspaceRoot),
      requireAcceptedEffect(createWriteTool(this.workspace), this.workspace),
      requireAcceptedEffect(createEditTool(this.workspace), this.workspace),
      createGrepTool(workspaceRoot),
      createGlobTool(workspaceRoot),
    ];
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

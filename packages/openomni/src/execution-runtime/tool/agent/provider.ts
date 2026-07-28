import type { Tool } from "@openomni/protocol";
import { createDefaultDispatchRuntime, type DispatchOwners } from "../../../dispatch/index.js";
import type { NativeTool, ToolCategory, ToolExecutionContext, ToolProvider } from "../types.js";
import {
  createDispatchTool,
  createWorkerResidentAskDispatchTool,
  type DispatchToolRuntime,
} from "./tools/dispatch.js";

export type AgentToolProviderOptions = {
  readonly dispatchRuntime?: DispatchToolRuntime;
  readonly dispatchOwners?: DispatchOwners;
  readonly dispatchToolMode?: "default" | "worker-resident-ask";
};

export class AgentToolProvider implements ToolProvider {
  readonly name = "agent";
  readonly category: ToolCategory = "agent";

  private extraTools: NativeTool[] = [];

  constructor(options?: AgentToolProviderOptions) {
    const dispatchRuntime =
      options?.dispatchRuntime ?? createDefaultDispatchRuntime({ owners: options?.dispatchOwners });
    this.register(
      options?.dispatchToolMode === "worker-resident-ask"
        ? createWorkerResidentAskDispatchTool(dispatchRuntime)
        : createDispatchTool(dispatchRuntime),
    );
  }

  register(tool: NativeTool): void {
    this.extraTools.push(tool);
  }

  listTools(): NativeTool[] {
    return [...this.extraTools];
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

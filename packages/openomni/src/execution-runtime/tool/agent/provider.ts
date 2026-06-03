import type { SubagentToolOptions } from "@openomni/agent";
import type { Tool } from "@openomni/protocol";
import { createDefaultDispatchRuntime, type DispatchOwners } from "../../../dispatch/index.js";
import type { NativeTool, ToolCategory, ToolExecutionContext, ToolProvider } from "../types.js";
import { createDispatchTool, type DispatchToolRuntime } from "./tools/dispatch.js";
import { createSubagentTool } from "./tools/subagent.js";
import { createSubagentRuntime } from "./tools/subagent-runtime.js";

export type AgentToolProviderOptions = Partial<SubagentToolOptions> & {
  readonly dispatchRuntime?: DispatchToolRuntime;
  readonly dispatchOwners?: DispatchOwners;
};

function hasSubagentOptions(options: AgentToolProviderOptions | undefined): boolean {
  if (!options) return false;
  return (
    "context" in options ||
    "delegationContext" in options ||
    "middleware" in options ||
    "defaultModel" in options ||
    "subagentRuntime" in options ||
    "backgroundManager" in options
  );
}

function resolveSubagentOptions(
  options: AgentToolProviderOptions | undefined,
): SubagentToolOptions | undefined {
  if (!hasSubagentOptions(options)) return undefined;
  const {
    dispatchRuntime: _dispatchRuntime,
    dispatchOwners: _dispatchOwners,
    ...partial
  } = options ?? {};
  return {
    ...partial,
    subagentRuntime: options?.subagentRuntime ?? createSubagentRuntime(),
  };
}

export class AgentToolProvider implements ToolProvider {
  readonly name = "agent";
  readonly category: ToolCategory = "agent";

  private readonly subagentOptions: SubagentToolOptions | undefined;
  private extraTools: NativeTool[] = [];

  constructor(options?: AgentToolProviderOptions) {
    this.subagentOptions = resolveSubagentOptions(options);
    const dispatchRuntime =
      options?.dispatchRuntime ?? createDefaultDispatchRuntime({ owners: options?.dispatchOwners });
    this.register(createDispatchTool(dispatchRuntime));
  }

  register(tool: NativeTool): void {
    this.extraTools.push(tool);
  }

  listTools(): NativeTool[] {
    return [createSubagentTool(this.subagentOptions), ...this.extraTools];
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

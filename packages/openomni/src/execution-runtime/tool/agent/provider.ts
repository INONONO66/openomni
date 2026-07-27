import type { Tool } from "@openomni/protocol";
import {
  createDefaultDispatchRuntime,
  type DefaultDispatchRuntimeOptions,
} from "../../../dispatch/index.js";
import { assertWorkspaceIdentity, type WorkspaceIdentity } from "../../workspace-identity.js";
import type { NativeTool, ToolCategory, ToolExecutionContext, ToolProvider } from "../types.js";
import {
  createDispatchTool,
  createWorkerResidentAskDispatchTool,
  type DispatchToolRuntime,
} from "./tools/dispatch.js";

export type AgentToolProviderOptions = DefaultDispatchRuntimeOptions & {
  readonly workspaceIdentity: WorkspaceIdentity;
  readonly dispatchRuntime?: DispatchToolRuntime;
  readonly dispatchToolMode?: "default" | "worker-resident-ask";
};

export class AgentToolProvider implements ToolProvider {
  readonly name = "agent";
  readonly category: ToolCategory = "agent";

  private extraTools: NativeTool[] = [];

  constructor(options: AgentToolProviderOptions) {
    const {
      dispatchRuntime: provisionedDispatchRuntime,
      dispatchToolMode,
      workspaceIdentity,
      ...runtimeOptions
    } = options;
    assertWorkspaceIdentity(workspaceIdentity);
    const dispatchRuntime =
      provisionedDispatchRuntime ?? createDefaultDispatchRuntime(runtimeOptions);
    const workspaceBoundRuntime: DispatchToolRuntime = {
      submit(input, submitOptions) {
        assertWorkspaceIdentity(workspaceIdentity);
        if (
          submitOptions?.workspaceRoot !== undefined &&
          submitOptions.workspaceRoot !== workspaceIdentity.canonicalRoot
        ) {
          return Promise.reject(
            new Error("dispatch workspace does not match provisioned identity"),
          );
        }
        return dispatchRuntime.submit(input, {
          ...submitOptions,
          workspaceRoot: workspaceIdentity.canonicalRoot,
        });
      },
    };
    this.register(
      dispatchToolMode === "worker-resident-ask"
        ? createWorkerResidentAskDispatchTool(workspaceBoundRuntime)
        : createDispatchTool(workspaceBoundRuntime),
    );
  }

  register(tool: NativeTool): void {
    this.extraTools.push(tool);
  }

  listTools(): NativeTool[] {
    return [...this.extraTools];
  }

  execute(call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result> {
    const tool = this.listTools().find((entry) => entry.spec.name === call.tool);
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

import type { SubagentToolOptions } from "@openomni/agent";
import type { Tool } from "@openomni/protocol";
import { IngressEngine } from "../../../ingress/engine.js";
import type { NativeTool, ToolCategory, ToolExecutionContext, ToolProvider } from "../types.js";
import { createInboundMessageTool, type InboundMessageIngress } from "./tools/inbound-message.js";
import { createSubagentTool } from "./tools/subagent.js";

export type AgentToolProviderOptions = SubagentToolOptions & {
  readonly ingressEngine?: InboundMessageIngress;
};

export class AgentToolProvider implements ToolProvider {
  readonly name = "agent";
  readonly category: ToolCategory = "agent";

  private readonly subagentOptions: SubagentToolOptions | undefined;
  private extraTools: NativeTool[] = [];

  constructor(options?: AgentToolProviderOptions) {
    this.subagentOptions = options;
    this.register(createInboundMessageTool(options?.ingressEngine ?? IngressEngine));
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

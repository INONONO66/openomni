import type { Tool } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { defineTool } from "../define.js";
import { requireString } from "../shared/input.js";
import { errorResult, fromError, successResult } from "../shared/result.js";
import type { NativeTool, ToolCategory, ToolProvider } from "../types.js";

const planWriteTool = defineTool<{ id: string; content: string }>({
  name: "plan_write",
  description: "Write or overwrite a plan by id",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Plan identifier" },
      content: { type: "string", description: "Plan content (markdown)" },
    },
    required: ["id", "content"],
  },
  riskTier: 1,
  async execute(call) {
    try {
      const id = requireString(call.input, "id");
      const content = requireString(call.input, "content");
      await Storage.get().plan!.write(id, content);
      return successResult(call, JSON.stringify({ ok: true, id }));
    } catch (err) {
      return fromError(call, err);
    }
  },
});

const planReadTool = defineTool<{ id: string }>({
  name: "plan_read",
  description: "Read a plan by id",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Plan identifier" },
    },
    required: ["id"],
  },
  riskTier: 0,
  isReadOnly: true,
  async execute(call) {
    try {
      const id = requireString(call.input, "id");
      const plan = await Storage.get().plan!.read(id);
      if (!plan) {
        return errorResult(call, `Plan not found: ${id}`);
      }
      return successResult(call, JSON.stringify(plan));
    } catch (err) {
      return fromError(call, err);
    }
  },
});

const planListTool = defineTool<Record<string, never>>({
  name: "plan_list",
  description: "List all plans",
  inputSchema: {
    type: "object",
    properties: {},
  },
  riskTier: 0,
  isReadOnly: true,
  async execute(call) {
    try {
      const plans = await Storage.get().plan!.list();
      return successResult(call, JSON.stringify(plans));
    } catch (err) {
      return fromError(call, err);
    }
  },
});

export class PlanToolProvider implements ToolProvider {
  readonly name = "plan";
  readonly category: ToolCategory = "system";

  listTools(): NativeTool[] {
    return [planWriteTool, planReadTool, planListTool];
  }

  execute(call: Tool.Call): Promise<Tool.Result> {
    const tool = this.listTools().find((entry) => entry.spec.name === call.tool);
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

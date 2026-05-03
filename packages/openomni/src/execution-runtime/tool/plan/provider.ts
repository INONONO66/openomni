import type { Tool } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { PLAN_TOOL_SPECS, createPlanToolExecutor } from "../../../plan/plan-tools.js";
import type { NativeTool, ToolCategory, ToolProvider } from "../types.js";

export class PlanToolProvider implements ToolProvider {
  readonly name = "plan";
  readonly category: ToolCategory = "system";

  listTools(): NativeTool[] {
    return PLAN_TOOL_SPECS.map((spec) => {
      const isReadOnly = spec.safe === true;
      return {
        spec,
        riskTier: isReadOnly ? 0 : 1,
        isReadOnly,
        isDestructive: false,
        isConcurrencySafe: false,
        source: "system" as const,
        execute: (call: Tool.Call) => this.execute(call),
      };
    });
  }

  execute(call: Tool.Call): Promise<Tool.Result> {
    const planSubAdapter = Storage.get().plan;
    if (!planSubAdapter) {
      throw new Error("Plan storage adapter is required for plan tool execution");
    }
    return createPlanToolExecutor(planSubAdapter)(call);
  }
}

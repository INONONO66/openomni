import type { Tool } from "@openomni/protocol";
import { Hashline } from "./hashline.js";
import type { PlanStore } from "./plan-store";

export const PLAN_TOOL_SPECS: Tool.Spec[] = [
  {
    name: "plan_read",
    description: "Read a plan with hashline format for precise editing",
    inputSchema: {
      type: "object",
      properties: {
        planId: { type: "string", description: "Plan identifier" },
        from: { type: "number", description: "Start line (1-based, inclusive, optional)" },
        to: { type: "number", description: "End line (1-based, inclusive, optional)" },
      },
      required: ["planId"],
    },
    safe: true,
  },
  {
    name: "plan_write",
    description: "Create or overwrite a plan with given markdown content",
    inputSchema: {
      type: "object",
      properties: {
        planId: { type: "string", description: "Plan identifier" },
        content: { type: "string", description: "Full markdown content" },
      },
      required: ["planId", "content"],
    },
    safe: false,
  },
  {
    name: "plan_edit",
    description: "Edit a plan using hashline refs for precise line-level changes",
    inputSchema: {
      type: "object",
      properties: {
        planId: { type: "string", description: "Plan identifier" },
        edits: {
          type: "array",
          description: "Array of edit operations (replace/append/prepend with hashline refs)",
          items: { type: "object" },
        },
      },
      required: ["planId", "edits"],
    },
    safe: false,
  },
];

export function createPlanToolExecutor(
  store: PlanStore,
): (call: Tool.Call) => Promise<Tool.Result> {
  const fail = (call: Tool.Call, message: string): Tool.Result => ({
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: message,
    isError: true,
  });

  const ok = (call: Tool.Call, output: string): Tool.Result => ({
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output,
    isError: false,
  });

  return async (call: Tool.Call): Promise<Tool.Result> => {
    switch (call.tool) {
      case "plan_read": {
        const { planId, from, to } = call.input as Record<string, unknown>;
        if (typeof planId !== "string") return fail(call, "planId must be a string");
        const fromNum = typeof from === "number" ? Math.floor(from) : undefined;
        const toNum = typeof to === "number" ? Math.floor(to) : undefined;
        if ((fromNum !== undefined && fromNum < 1) || (toNum !== undefined && toNum < 1))
          return fail(call, "from and to must be positive integers");

        const doc = store.read(planId);
        if (!doc) return fail(call, `Plan '${planId}' not found`);

        if (fromNum !== undefined || toNum !== undefined) {
          const lineCount = doc.content.split("\n").length;
          return ok(call, Hashline.formatRange(doc.content, fromNum ?? 1, toNum ?? lineCount));
        }
        return ok(call, Hashline.format(doc.content));
      }

      case "plan_write": {
        const { planId, content } = call.input as Record<string, unknown>;
        if (typeof planId !== "string") return fail(call, "planId must be a string");
        if (typeof content !== "string") return fail(call, "content must be a string");

        store.write(planId, content);
        const lineCount = content.split("\n").length;
        return ok(call, `Plan '${planId}' created (${lineCount} lines)`);
      }

      case "plan_edit": {
        const { planId, edits } = call.input as Record<string, unknown>;
        if (typeof planId !== "string") return fail(call, "planId must be a string");
        if (!Array.isArray(edits)) return fail(call, "edits must be an array");
        if (edits.some((e) => e === null || typeof e !== "object"))
          return fail(call, "each edit must be a non-null object");

        const result = store.edit(planId, edits as Hashline.EditOp[]);
        if (!result.ok) return fail(call, result.errors.join("\n"));
        return ok(call, `Plan '${planId}' edited`);
      }

      default:
        return fail(call, `Unknown tool: ${call.tool}`);
    }
  };
}

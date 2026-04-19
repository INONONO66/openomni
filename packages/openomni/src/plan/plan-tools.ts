import type { Storage, Tool } from "@openomni/protocol";
import { Hashline } from "./hashline.js";

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
          description: "Edit operations with hashline refs",
          items: { type: "object" },
        },
      },
      required: ["planId", "edits"],
    },
    safe: false,
  },
  {
    name: "plan_list",
    description: "List all plans",
    inputSchema: {
      type: "object",
      properties: {},
    },
    safe: true,
  },
];

export function createPlanToolExecutor(
  adapter: Storage.PlanSubAdapter,
): (call: Tool.Call) => Promise<Tool.Result> {
  const fail = (call: Tool.Call, msg: string): Tool.Result => ({
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: msg,
    isError: true,
  });
  const ok = (call: Tool.Call, out: string): Tool.Result => ({
    id: crypto.randomUUID(),
    toolCallId: call.id,
    output: out,
  });

  return async (call: Tool.Call): Promise<Tool.Result> => {
    const inp = call.input as Record<string, unknown>;

    switch (call.tool) {
      case "plan_read": {
        const { planId, from, to } = inp;
        if (typeof planId !== "string") return fail(call, "planId must be a string");
        const fromNum =
          typeof from === "number" && Number.isFinite(from) ? Math.floor(from) : undefined;
        const toNum = typeof to === "number" && Number.isFinite(to) ? Math.floor(to) : undefined;
        if (
          (from !== undefined && fromNum === undefined) ||
          (to !== undefined && toNum === undefined)
        )
          return fail(call, "from and to must be finite numbers");
        if ((fromNum !== undefined && fromNum < 1) || (toNum !== undefined && toNum < 1))
          return fail(call, "from and to must be positive integers");
        const doc = await adapter.read(planId);
        if (!doc) return fail(call, `Plan '${planId}' not found`);
        const formatted =
          fromNum !== undefined || toNum !== undefined
            ? Hashline.formatRange(
                doc.content,
                fromNum ?? 1,
                toNum ?? doc.content.split("\n").length,
              )
            : Hashline.format(doc.content);
        return ok(
          call,
          JSON.stringify({
            content: formatted,
            version: doc.version,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
          }),
        );
      }
      case "plan_write": {
        const { planId, content } = inp;
        if (typeof planId !== "string") return fail(call, "planId must be a string");
        if (typeof content !== "string") return fail(call, "content must be a string");
        await adapter.write(planId, content);
        return ok(call, JSON.stringify({ ok: true, id: planId }));
      }
      case "plan_edit": {
        const { planId, edits } = inp;
        if (typeof planId !== "string") return fail(call, "planId must be a string");
        if (!Array.isArray(edits)) return fail(call, "edits must be an array");
        if (edits.some((e) => e === null || typeof e !== "object"))
          return fail(call, "each edit must be a non-null object");
        const doc = await adapter.read(planId);
        if (!doc) return fail(call, `Plan '${planId}' not found`);
        const editResult = Hashline.applyEdits(doc.content, edits as Hashline.EditOp[]);
        if (!editResult.ok) return fail(call, editResult.errors.join("\n"));
        await adapter.write(planId, editResult.content);
        return ok(call, `Plan '${planId}' edited`);
      }
      case "plan_list": {
        const plans = await adapter.list();
        return ok(call, JSON.stringify(plans));
      }
      default:
        return fail(call, `Unknown tool: ${call.tool}`);
    }
  };
}

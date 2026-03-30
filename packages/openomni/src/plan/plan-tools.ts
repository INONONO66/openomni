import { Hashline, type Tool } from "@openomni/protocol";
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
  return async (call: Tool.Call): Promise<Tool.Result> => {
    switch (call.tool) {
      case "plan_read": {
        const { planId, from, to } = call.input as {
          planId: string;
          from?: number;
          to?: number;
        };
        const doc = store.read(planId);
        if (!doc) {
          return {
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: `Plan '${planId}' not found`,
            isError: true,
          };
        }
        const formatted =
          from !== undefined && to !== undefined
            ? Hashline.formatRange(doc.content, from, to)
            : Hashline.format(doc.content);
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: formatted,
          isError: false,
        };
      }

      case "plan_write": {
        const { planId, content } = call.input as {
          planId: string;
          content: string;
        };
        store.write(planId, content);
        const lineCount = content.split("\n").length;
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: `Plan '${planId}' created (${lineCount} lines)`,
          isError: false,
        };
      }

      case "plan_edit": {
        const { planId, edits } = call.input as {
          planId: string;
          edits: Hashline.EditOp[];
        };
        const result = store.edit(planId, edits);
        if (!result.ok) {
          return {
            id: crypto.randomUUID(),
            toolCallId: call.id,
            output: result.errors.join("\n"),
            isError: true,
          };
        }
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: `Plan '${planId}' edited`,
          isError: false,
        };
      }

      default: {
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: `Unknown tool: ${call.tool}`,
          isError: true,
        };
      }
    }
  };
}

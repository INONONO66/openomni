import { z } from "zod";
import type { CompletionJudgment, CompletionPort } from "../../work-item/completion";
import { defineTool, ToolRefused } from "../core/define";

const Judgment = z.discriminatedUnion("value", [
  z.object({ criterionId: z.string().min(1), value: z.literal("asserted") }).strict(),
  z
    .object({
      criterionId: z.string().min(1),
      value: z.enum(["verified", "refuted"]),
      checkedPredicate: z.string().min(1),
      evidenceIds: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);
const Input = z
  .object({
    op: z.union([z.literal("list"), z.literal("get"), z.literal("complete")]),
    workItemId: z.string().min(1).optional(),
    judgments: z.array(Judgment).min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.op !== "list" && value.workItemId === undefined) {
      ctx.addIssue({ code: "custom", message: `${value.op} requires workItemId` });
    }
    if (value.op === "complete" && value.judgments === undefined) {
      ctx.addIssue({ code: "custom", message: "complete requires judgments" });
    }
  });
const Summary = z.custom<object>((value) => typeof value === "object" && value !== null);
const Output = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list"), items: z.array(Summary) }).strict(),
  z.object({ op: z.literal("get"), item: Summary }).strict(),
  z
    .object({ op: z.literal("complete"), admitted: z.literal(true), workItemId: z.string() })
    .strict(),
]);
const WORK_ITEMS_TOOL_NAME = "work_items";

export function createWorkItemsTool(port: CompletionPort) {
  return defineTool({
    name: WORK_ITEMS_TOOL_NAME,
    category: "mutation",
    description:
      "List or inspect commissioned WorkItems, or complete one with verified evidence-backed judgments. Use op=list|get|complete.",
    input: Input,
    output: Output,
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: async (input) => {
      if (input.op === "list") return { op: "list" as const, items: port.list() };
      if (input.op === "get") {
        const item = port.inspect(input.workItemId as string);
        if (item === undefined)
          throw new ToolRefused(WORK_ITEMS_TOOL_NAME, `unknown WorkItem ${input.workItemId}`);
        return { op: "get" as const, item };
      }
      const outcome = await port.complete({
        workItemId: input.workItemId as string,
        judgments: input.judgments as readonly CompletionJudgment[],
      });
      if (!outcome.admitted) throw new ToolRefused(WORK_ITEMS_TOOL_NAME, outcome.reason);
      return { op: "complete" as const, admitted: true as const, workItemId: outcome.workItemId };
    },
    render: (_args, value) =>
      value.op === "complete"
        ? `WorkItem ${value.workItemId} completed: admission recorded and terminal receipt written.`
        : JSON.stringify(value.op === "list" ? value.items : value.item, null, 2),
  });
}

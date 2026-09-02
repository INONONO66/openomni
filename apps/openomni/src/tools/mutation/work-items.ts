import { z } from "zod";
import type { CompletionJudgment, CompletionPort } from "../../work-item/completion";
import { defineTool, ToolRefused } from "../core/define";

const Judgment = z.discriminatedUnion("value", [
  z.object({ criterionId: z.string().min(1), value: z.literal("asserted") }).strict(),
  z.object({
    criterionId: z.string().min(1), value: z.enum(["verified", "refuted"]),
    checkedPredicate: z.string().min(1).describe("What you actually checked."),
    evidenceIds: z.array(z.string().min(1)).min(1).describe("Evidence ids the check consumed."),
  }).strict(),
]).describe("One judgment per criterion. Only verified admits.");
const Input = z.object({ workItemId: z.string().min(1), judgments: z.array(Judgment).min(1) }).strict();
const Output = z.object({ admitted: z.literal(true), workItemId: z.string() }).strict();
const COMPLETE_WORK_TOOL_NAME = "complete_work";
function executeCompleteWork(port: CompletionPort) {
  return async (input: z.output<typeof Input>): Promise<z.output<typeof Output>> => {
    const outcome = await port.complete({ workItemId: input.workItemId, judgments: input.judgments as readonly CompletionJudgment[] });
    if (!outcome.admitted) throw new ToolRefused(COMPLETE_WORK_TOOL_NAME, outcome.reason);
    return outcome;
  };
}
export const completeWorkTool = defineTool({
  name: COMPLETE_WORK_TOOL_NAME, category: "mutation",
  description: "Judge a WorkItem's acceptance criteria for completion admission. Only verified judgments (with the predicate you checked and the evidence ids consumed) admit; asserted or refuted judgments record a durable block and refuse.",
  input: Input,
  inputExamples: [{ workItemId: "work-item-id", judgments: [{ criterionId: "criterion-id", value: "verified", checkedPredicate: "the expected behavior was exercised", evidenceIds: ["evidence-id"] }] }],
  output: Output, safe: false, execution: { kind: "host" }, placement: "host",
  visibility: { model: ["resident"], cell: ["resident"] },
  bind: (ports) => ports.workItems === undefined ? undefined : executeCompleteWork(ports.workItems),
  render: (_args, value) => `WorkItem ${value.workItemId} completed: admission recorded and terminal receipt written.`,
});

export function completeWorkToolExecutor(port: CompletionPort) { return async (raw: unknown): Promise<string> => { try { const args = Input.parse(raw); return completeWorkTool.render(args, await executeCompleteWork(port)(args)); } catch (error) { return error instanceof ToolRefused ? error.message : `complete_work refused: ${error instanceof Error ? error.message : String(error)}`; } }; }

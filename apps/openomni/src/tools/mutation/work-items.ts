import { z } from "zod";
import type { CompletionPort } from "../../work-item/completion";
import { defineTool, ToolRefused } from "../core/define";

const Judgment = z.discriminatedUnion("value", [
  z.object({ criterionId: z.string().min(1), value: z.literal("asserted") }).strict(),
  z.object({
    criterionId: z.string().min(1), value: z.enum(["verified", "refuted"]),
    checkedPredicate: z.string().min(1).describe("What you actually checked."),
    evidenceIds: z.array(z.string().min(1)).min(1).describe("Evidence ids the check consumed."),
  }).strict(),
  z.object({
    criterionId: z.string().min(1),
    value: z.literal("recorded"),
    resultId: z.string().min(1).describe("Verifier-recorded verified result id; do not restate the check."),
  }).strict(),
]).describe("One judgment per criterion. Only verified or recorded-verified admits.");
const Input = z.object({ workItemId: z.string().min(1), judgments: z.array(Judgment).min(1) }).strict();
const Output = z.object({ admitted: z.literal(true), workItemId: z.string() }).strict();
const COMPLETE_WORK_TOOL_NAME = "complete_work";
function executeCompleteWork(port: CompletionPort) {
  return async (input: z.output<typeof Input>): Promise<z.output<typeof Output>> => {
    const outcome = await port.complete({ workItemId: input.workItemId, judgments: input.judgments });
    if (!outcome.admitted) throw new ToolRefused(COMPLETE_WORK_TOOL_NAME, outcome.reason);
    return outcome;
  };
}
export const completeWorkTool = defineTool({
  name: COMPLETE_WORK_TOOL_NAME, category: "mutation",
  description: "Judge a WorkItem's acceptance criteria for completion admission. Consume a verifier-recorded verified result by id without restating its check, or submit the existing Resident judgment arms. Asserted or refuted judgments record a durable block and refuse.",
  input: Input,
  inputExamples: [{ workItemId: "work-item-id", judgments: [{ criterionId: "criterion-id", value: "verified", checkedPredicate: "the expected behavior was exercised", evidenceIds: ["evidence-id"] }] }],
  output: Output, safe: false, execution: { kind: "host" }, placement: "host",
  visibility: { model: ["resident"], cell: ["resident"] },
  bind: (ports) => ports.workItems === undefined ? undefined : executeCompleteWork(ports.workItems),
  render: (_args, value) => `WorkItem ${value.workItemId} completed: admission recorded and terminal receipt written.`,
});

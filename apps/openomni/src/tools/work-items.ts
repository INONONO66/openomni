import type { Tool } from "@openomni/protocol";
import { z } from "zod";
import type { CompletionJudgment, CompletionPort } from "../work-item/completion";

/**
 * The Resident's completion surface over commissioned WorkItems: inspect what
 * a delegation produced, then judge each acceptance criterion. Only verified
 * judgments admit — a worker's own report is Evidence, never completion.
 */

const WORK_ITEMS_TOOL_NAME = "work_items";
const COMPLETE_WORK_TOOL_NAME = "complete_work";

const InspectInput = z
  .object({
    workItemId: z.string().min(1).optional().describe("Inspect one WorkItem; omit to list all."),
  })
  .strict();

const Judgment = z
  .discriminatedUnion("value", [
    z.object({ criterionId: z.string().min(1), value: z.literal("asserted") }).strict(),
    z
      .object({
        criterionId: z.string().min(1),
        value: z.enum(["verified", "refuted"]),
        checkedPredicate: z.string().min(1).describe("What you actually checked."),
        evidenceIds: z.array(z.string().min(1)).min(1).describe("Evidence ids the check consumed."),
      })
      .strict(),
  ])
  .describe("One judgment per criterion. Only verified admits.");

const CompleteInput = z
  .object({
    workItemId: z.string().min(1),
    judgments: z.array(Judgment).min(1),
  })
  .strict();

const INSPECT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    workItemId: {
      type: "string",
      minLength: 1,
      description: "Inspect one WorkItem; omit to list all.",
    },
  },
};

const COMPLETE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["workItemId", "judgments"],
  properties: {
    workItemId: { type: "string", minLength: 1 },
    judgments: {
      type: "array",
      minItems: 1,
      description: "One judgment per criterion. Only verified admits.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterionId", "value"],
        properties: {
          criterionId: { type: "string", minLength: 1 },
          value: { type: "string", enum: ["verified", "refuted", "asserted"] },
          checkedPredicate: {
            type: "string",
            minLength: 1,
            description: "What you actually checked (verified and refuted only).",
          },
          evidenceIds: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
            description: "Evidence ids the check consumed (verified and refuted only).",
          },
        },
      },
    },
  },
};

export function workItemsToolSpec(): Tool.Spec {
  return {
    name: WORK_ITEMS_TOOL_NAME,
    description:
      "Inspect commissioned WorkItems: status, acceptance criteria (with ids), recorded evidence, and the attempt outcome. Pass workItemId for one item's detail; omit it to list everything.",
    inputSchema: INSPECT_JSON_SCHEMA,
    safe: true,
    placement: "host",
  };
}

export function completeWorkToolSpec(): Tool.Spec {
  return {
    name: COMPLETE_WORK_TOOL_NAME,
    description:
      "Judge a WorkItem's acceptance criteria for completion admission. Only verified judgments (with the predicate you checked and the evidence ids consumed) admit; asserted or refuted judgments record a durable block and refuse.",
    inputSchema: COMPLETE_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

export function workItemsToolExecutor(port: CompletionPort) {
  return (rawInput: unknown): Promise<string> => {
    const parsed = InspectInput.safeParse(rawInput ?? {});
    if (!parsed.success) {
      return Promise.resolve(
        `work_items refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`,
      );
    }
    const { workItemId } = parsed.data;
    if (workItemId === undefined) {
      return Promise.resolve(JSON.stringify(port.list(), null, 2));
    }
    const summary = port.inspect(workItemId);
    return Promise.resolve(
      summary === undefined
        ? `work_items refused: unknown WorkItem ${workItemId}`
        : JSON.stringify(summary, null, 2),
    );
  };
}

export function completeWorkToolExecutor(port: CompletionPort) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = CompleteInput.safeParse(rawInput);
    if (!parsed.success) {
      return `complete_work refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    const outcome = await port.complete({
      workItemId: parsed.data.workItemId,
      judgments: parsed.data.judgments as readonly CompletionJudgment[],
    });
    return outcome.admitted
      ? `WorkItem ${outcome.workItemId} completed: admission recorded and terminal receipt written.`
      : `complete_work refused: ${outcome.reason}`;
  };
}

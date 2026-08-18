import { WorkItem } from "@openomni/protocol";
import { defaultMaxAttempts } from "./retry-policy.js";
import type { CreateWorkItemInput } from "./types.js";

export function buildWorkItem(input: CreateWorkItemInput, now: number): WorkItem.Info {
  const maxAttempts = input.maxAttempts ?? defaultMaxAttempts(input.executorKind);
  const hash = WorkItem.generateHash();
  const criteria = input.acceptanceCriteria.map((statement, index) => ({
    id: WorkItem.criterionId(hash, index, statement),
    revision: 1,
    statement,
    required: true,
  }));
  return WorkItem.Info.parse({
    hash,
    // Birth revision 1 (#510 C1): the work_item.created fact is seq 1 on the
    // owner stream, so head === revision from birth.
    revision: 1,
    name: input.name,
    sourceMessageId: input.sourceMessageId,
    sourceChannel: input.sourceChannel,
    assigneeId: input.assigneeId,
    sessionId: input.sessionId,
    originSessionId: input.originSessionId,
    workSessionId: input.workSessionId,
    workerRunId: input.workerRunId,
    executorKind: input.executorKind,
    maxAttempts,
    attempt: 1,
    lastAttemptSeq: 0,
    timestamps: { created: now, updated: now },
    relations: {
      parentId: input.parentId,
      childIds: [],
      dependsOn: input.dependsOn ?? [],
    },
    intent: input.intent,
    goal: input.goal,
    context: input.context,
    constraints: input.constraints ?? [],
    acceptanceCriteria: input.acceptanceCriteria,
    changedFiles: [],
    blockers: [],
    evidence: [],
    completionContract: {
      version: 1,
      revision: "1",
      basisRef: `${hash}:attempt:1`,
    },
    completionFacts: { ...WorkItem.emptyCompletionFacts(), criteria },
  });
}

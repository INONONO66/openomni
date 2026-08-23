import type { Ledger, WorkItem } from "@openomni/protocol";
import { Transcript, WorkItem as WorkItemSchema } from "@openomni/protocol";
import type { Storage } from "@openomni/ledger";
import { ProjectionStep, type ProjectionInput, type ProjectionStep as Step } from "./flat-event";
import type { SidecarStore } from "./sidecar-store";

/**
 * Transcript attemptIds identify LLM-processor attempts, not WorkItem attempts.
 * A row belongs to the latest WorkItem allocation recorded no later than that row.
 */
export type ProjectionMaterials = {
  workItem: WorkItem.Info;
  attemptFacts: Ledger.RecordedFact[];
  transcriptRows: Storage.TranscriptFactRow[];
};

export type ProjectionAssemblyErrorReason = "step_before_first_attempt" | "corrupt_fact";

export class ProjectionAssemblyError extends Error {
  readonly name = "ProjectionAssemblyError";

  constructor(
    readonly reason: ProjectionAssemblyErrorReason,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

type Allocation = { attempt: WorkItem.Attempt; timeCreated: number };

function parseAttemptFact(fact: Ledger.RecordedFact): Allocation {
  try {
    if (fact.type !== "work_item.attempt_allocated") {
      throw new Error(`unexpected attempt fact type: ${fact.type}`);
    }
    const { revision: _revision, ...identity } = fact.data;
    return {
      attempt: WorkItemSchema.Attempt.parse(identity),
      timeCreated: fact.timeCreated,
    };
  } catch (error) {
    throw new ProjectionAssemblyError(
      "corrupt_fact",
      `corrupt work-item attempt fact at ${fact.streamId}#${fact.seq}`,
      error,
    );
  }
}

function parseTranscriptRow(row: Storage.TranscriptFactRow): Transcript.Fact {
  try {
    const fact = Transcript.Fact.parse(JSON.parse(row.data));
    if (fact.type !== row.type) {
      throw new Error(`transcript row type ${row.type} does not match payload ${fact.type}`);
    }
    return fact;
  } catch (error) {
    throw new ProjectionAssemblyError(
      "corrupt_fact",
      `corrupt transcript fact at ${row.sessionID}#${row.seq}`,
      error,
    );
  }
}

function attributedAttempt(allocations: Allocation[], timeCreated: number): WorkItem.Attempt {
  let latest: WorkItem.Attempt | undefined;
  for (const allocation of allocations) {
    if (allocation.timeCreated <= timeCreated) latest = allocation.attempt;
  }
  if (latest === undefined) {
    throw new ProjectionAssemblyError(
      "step_before_first_attempt",
      `transcript step at ${timeCreated} predates the first WorkItem attempt allocation`,
    );
  }
  return latest;
}

function emptyStep(
  materials: ProjectionMaterials,
  row: Storage.TranscriptFactRow,
  ordinal: number,
  attempt: WorkItem.Attempt,
  op: Transcript.Fact["type"],
): Step {
  return {
    order: { timeCreated: row.timeCreated, streamId: row.sessionID, seq: ordinal },
    ownerKey: `work:${materials.workItem.workItemId}`,
    workItemId: materials.workItem.workItemId,
    attempt,
    step: ordinal,
    parentStep: null,
    agent: null,
    op,
    thought: null,
    action: null,
    actionArgs: null,
    observationHash: null,
    model: null,
    inTokens: null,
    outTokens: null,
    finishReason: null,
    verifierStatus: null,
    checkedPredicate: null,
    errorType: null,
    planDivergence: null,
    stateHash: null,
    promptHash: null,
    cacheKey: null,
    replayKey: null,
    nondeterminismManifestHash: null,
  };
}

function completedObservation(output: string, sidecar: SidecarStore): string {
  return sidecar.put(JSON.stringify(output));
}

export function assembleProjectionInput(
  materials: ProjectionMaterials,
  sidecar: SidecarStore,
): ProjectionInput {
  const allocations = materials.attemptFacts.map(parseAttemptFact);
  const toolPartIds = new Set<string>();
  const steps = materials.transcriptRows.map((row, ordinal) => {
    const fact = parseTranscriptRow(row);
    const attempt = attributedAttempt(allocations, row.timeCreated);
    const step = emptyStep(materials, row, ordinal, attempt, fact.type);

    switch (fact.type) {
      case "message.created":
        if (fact.message.role === "assistant") step.model = fact.message.modelID;
        break;
      case "part.appended":
        if (fact.part.type === "text" || fact.part.type === "reasoning") {
          step.thought = fact.part.text;
        } else if (fact.part.type === "tool") {
          toolPartIds.add(fact.part.id);
          step.action = fact.part.tool;
          step.actionArgs = ProjectionStep.shape.actionArgs.parse(fact.part.state.input);
          if (fact.part.state.status === "completed") {
            step.observationHash = completedObservation(fact.part.state.output, sidecar);
          }
        }
        break;
      case "part.advanced":
        if (fact.transition.to === "completed" && toolPartIds.has(fact.partId)) {
          step.observationHash = completedObservation(fact.transition.output, sidecar);
        }
        break;
      case "message.finished":
        step.inTokens = fact.usage.input;
        step.outTokens = fact.usage.output;
        step.finishReason = fact.finish;
        break;
    }

    return ProjectionStep.parse(step);
  });

  return { steps };
}

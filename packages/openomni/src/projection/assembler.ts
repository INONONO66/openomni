import type { Ledger, WorkItem } from "@openomni/protocol";
import { Transcript, WorkItem as WorkItemSchema } from "@openomni/protocol";
import type { Storage } from "@openomni/ledger";
import {
  ProjectionStep,
  type ProjectionInput,
  type ProjectionStep as Step,
} from "./flat-event";
import type { SidecarStore } from "./sidecar-store";

/**
 * Transcript attemptIds identify LLM-processor attempts, not WorkItem attempts,
 * and transcript facts currently record no WorkItem ownership edge. Attribution
 * is therefore a recorded-window heuristic: a row belongs to the globally
 * latest same-session allocation at-or-before its time, ordered by
 * (timeCreated, streamId, seq), only when that allocation belongs to this
 * WorkItem and its terminal/next-allocation boundary has not passed. Thus the
 * newer allocation wins across same-session WorkItems, including open ones; a
 * terminal `endedAt` boundary is inclusive. Rows outside every owned window
 * belong to another owner and are excluded. The two clocks remain a known limitation:
 * ledger append time and TranscriptStore's Date.now() are recorded separately.
 */
export type ProjectionMaterials = {
  workItem: WorkItem.Info;
  /** Allocation and terminal facts from this WorkItem's owner stream. */
  attemptFacts: Ledger.RecordedFact[];
  /** Allocation facts from sibling WorkItems sharing this transcript session. */
  siblingAllocationFacts: Ledger.RecordedFact[];
  transcriptRows: Storage.TranscriptFactRow[];
};

export type ProjectionAssemblyErrorReason = "corrupt_fact";

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

type Allocation = {
  attempt: WorkItem.Attempt;
  timeCreated: number;
  streamId: string;
  seq: number;
};
type AttemptWindow = { attempt: WorkItem.Attempt; start: number; end?: number };
type ToolIdentity = { action: string; actionArgs: Step["actionArgs"] };

function corruptAttemptFact(
  fact: Ledger.RecordedFact,
  cause: unknown,
): ProjectionAssemblyError {
  return new ProjectionAssemblyError(
    "corrupt_fact",
    `corrupt work-item attempt fact at ${fact.streamId}#${fact.seq}`,
    cause,
  );
}

function parseAllocation(fact: Ledger.RecordedFact): Allocation {
  try {
    const { revision: _revision, ...identity } = fact.data;
    return {
      attempt: WorkItemSchema.Attempt.parse(identity),
      timeCreated: fact.timeCreated,
      streamId: fact.streamId,
      seq: fact.seq,
    };
  } catch (error) {
    throw corruptAttemptFact(fact, error);
  }
}

function parseTerminal(fact: Ledger.RecordedFact): WorkItem.AttemptTerminal {
  try {
    const { revision: _revision, ...terminal } = fact.data;
    return WorkItemSchema.AttemptTerminal.parse(terminal);
  } catch (error) {
    throw corruptAttemptFact(fact, error);
  }
}

function buildAttemptWindows(facts: Ledger.RecordedFact[]): AttemptWindow[] {
  const allocations: Allocation[] = [];
  const terminals = new Map<string, WorkItem.AttemptTerminal>();
  for (const fact of [...facts].sort((a, b) => a.seq - b.seq)) {
    if (fact.type === "work_item.attempt_allocated") {
      allocations.push(parseAllocation(fact));
    } else if (fact.type === "work_item.attempt_finished") {
      const terminal = parseTerminal(fact);
      if (terminals.has(terminal.attemptId)) {
        throw corruptAttemptFact(
          fact,
          new Error(`duplicate terminal for ${terminal.attemptId}`),
        );
      }
      terminals.set(terminal.attemptId, terminal);
    } else {
      throw corruptAttemptFact(
        fact,
        new Error(`unexpected attempt fact type: ${fact.type}`),
      );
    }
  }

  return allocations.map((allocation, index) => {
    const terminalEnd = terminals.get(allocation.attempt.attemptId)?.endedAt;
    const nextStart = allocations[index + 1]?.timeCreated;
    const end =
      terminalEnd === undefined
        ? nextStart
        : nextStart === undefined
          ? terminalEnd
          : Math.min(terminalEnd, nextStart);
    return {
      attempt: allocation.attempt,
      start: allocation.timeCreated,
      ...(end === undefined ? {} : { end }),
    };
  });
}

function parseTranscriptRow(row: Storage.TranscriptFactRow): Transcript.Fact {
  try {
    const fact = Transcript.Fact.parse(JSON.parse(row.data));
    if (fact.type !== row.type) {
      throw new Error(
        `transcript row type ${row.type} does not match payload ${fact.type}`,
      );
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

function compareAllocations(a: Allocation, b: Allocation): number {
  if (a.timeCreated !== b.timeCreated) return a.timeCreated - b.timeCreated;
  const streamOrder =
    a.streamId === b.streamId ? 0 : a.streamId < b.streamId ? -1 : 1;
  if (streamOrder !== 0) return streamOrder;
  return a.seq - b.seq;
}

function attributedAttempt(
  windows: AttemptWindow[],
  sessionAllocations: Allocation[],
  timeCreated: number,
): WorkItem.Attempt | undefined {
  let winner: Allocation | undefined;
  for (const allocation of sessionAllocations) {
    if (
      allocation.timeCreated <= timeCreated &&
      (winner === undefined || compareAllocations(winner, allocation) < 0)
    ) {
      winner = allocation;
    }
  }
  if (
    winner === undefined ||
    !windows.some(
      (window) => window.attempt.attemptId === winner.attempt.attemptId,
    )
  ) {
    return undefined;
  }

  for (let index = windows.length - 1; index >= 0; index -= 1) {
    const window = windows[index];
    if (
      window !== undefined &&
      window.attempt.attemptId === winner.attempt.attemptId &&
      window.start <= timeCreated &&
      (window.end === undefined || timeCreated <= window.end)
    ) {
      return window.attempt;
    }
  }
  return undefined;
}

function emptyStep(
  materials: ProjectionMaterials,
  row: Storage.TranscriptFactRow,
  attempt: WorkItem.Attempt,
  op: Transcript.Fact["type"],
): Step {
  return {
    order: {
      timeCreated: row.timeCreated,
      streamId: row.sessionID,
      seq: row.seq,
    },
    ownerKey: `work:${materials.workItem.workItemId}`,
    workItemId: materials.workItem.workItemId,
    attempt,
    step: row.seq,
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

function completedObservation(output: unknown, sidecar: SidecarStore): string {
  // Recorded strings are already the observation bytes; structured future
  // outputs use their JSON encoding so the sidecar still receives exact bytes.
  if (typeof output === "string") return sidecar.put(output);
  const encoded = JSON.stringify(output);
  if (encoded === undefined) {
    throw new ProjectionAssemblyError(
      "corrupt_fact",
      "tool output is not JSON-encodable",
    );
  }
  return sidecar.put(encoded);
}

export function assembleProjectionInput(
  materials: ProjectionMaterials,
  sidecar: SidecarStore,
): ProjectionInput {
  const windows = buildAttemptWindows(materials.attemptFacts);
  const ownAllocationFacts = materials.attemptFacts.filter(
    (fact) => fact.type === "work_item.attempt_allocated",
  );
  const sessionAllocations = [
    ...ownAllocationFacts,
    ...materials.siblingAllocationFacts,
  ].map(parseAllocation);
  const retainedRows = materials.transcriptRows.flatMap((row) => {
    const attempt = attributedAttempt(
      windows,
      sessionAllocations,
      row.timeCreated,
    );
    return attempt === undefined ? [] : [{ row, attempt }];
  });
  const retainedSeqs = new Set<string>();
  for (const { row } of retainedRows) {
    const key = `${row.sessionID}:${row.seq}`;
    if (retainedSeqs.has(key)) {
      throw new ProjectionAssemblyError(
        "corrupt_fact",
        `duplicate transcript seq at ${row.sessionID}#${row.seq}`,
      );
    }
    retainedSeqs.add(key);
  }

  const messageAgents = new Map<string, Step["agent"]>();
  const toolParts = new Map<string, ToolIdentity>();
  const steps: Step[] = [];

  for (const { row, attempt } of retainedRows) {
    const fact = parseTranscriptRow(row);
    const step = emptyStep(materials, row, attempt, fact.type);
    if (fact.type !== "message.created") {
      step.agent = messageAgents.get(fact.messageId) ?? null;
    }

    switch (fact.type) {
      case "message.created":
        step.agent = fact.message.agent;
        messageAgents.set(fact.message.id, fact.message.agent);
        if (fact.message.role === "assistant")
          step.model = fact.message.modelID;
        break;
      case "part.appended":
        if (fact.part.type === "text" || fact.part.type === "reasoning") {
          step.thought = fact.part.text;
        } else if (fact.part.type === "tool") {
          const identity = {
            action: fact.part.tool,
            actionArgs: ProjectionStep.shape.actionArgs.parse(
              fact.part.state.input,
            ),
          };
          toolParts.set(`${fact.attemptId}:${fact.part.id}`, identity);
          step.action = identity.action;
          step.actionArgs = identity.actionArgs;
          if (fact.part.state.status === "completed") {
            step.observationHash = completedObservation(
              fact.part.state.output,
              sidecar,
            );
          }
        }
        break;
      case "part.advanced": {
        const identity = toolParts.get(`${fact.attemptId}:${fact.partId}`);
        if (identity !== undefined) {
          step.action = identity.action;
          step.actionArgs = identity.actionArgs;
          if (fact.transition.to === "completed") {
            step.observationHash = completedObservation(
              fact.transition.output,
              sidecar,
            );
          }
        }
        break;
      }
      case "message.finished":
        step.inTokens = fact.usage.input;
        step.outTokens = fact.usage.output;
        step.finishReason = fact.finish;
        break;
    }

    steps.push(ProjectionStep.parse(step));
  }

  return { steps };
}

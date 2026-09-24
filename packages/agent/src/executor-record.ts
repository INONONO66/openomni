import {
  L0Observation,
  Tool,
  type LedgerAction,
  type ObservationSink,
  type BusEvent,
  type PlainValue,
  type PlainObject,
} from "@openomni/protocol";
import type { ExecutionRequest, ResolvedExecutorOptions } from "./executor-contract";
import { Effect } from "effect";
import { CommitFailed, type ExecutionError } from "./errors";
import { failureEvidence } from "./executor-outcome";

export type ToolObservationStatus = "success" | "error" | "timed_out";
type ToolObservationIdentity = NonNullable<ExecutionRequest["toolObservation"]>;
interface ActionSubject {
  readonly kind: LedgerAction.Kind;
  readonly op: string;
}

/** One record-before-observe adapter over the session's existing fenced ledger port. */
export function createExecutionRecord(
  options: Pick<ResolvedExecutorOptions, "ledger" | "observations" | "identity" | "clock" | "entropy">,
) {
  function commit(action: LedgerAction.Append): Effect.Effect<LedgerAction.Receipt, CommitFailed> {
    return options.ledger.commit(action).pipe(
      Effect.mapError((error) => new CommitFailed({ error })),
      Effect.map((receipt) => {
        options.observations.publish(L0Observation.ActionCommittedEvent, {
          id: receipt.action.id,
          sessionId: receipt.action.sessionId,
          revision: receipt.revision,
          kind: receipt.action.kind,
        });
        return receipt;
      }),
    );
  }

  function appendFailure(
    subject: ActionSubject,
    parentId: string,
    effect: PlainValue,
    error: ExecutionError,
    callId?: string,
    toolResult?: Tool.Result,
  ): Effect.Effect<void, CommitFailed> {
    return appendResult(subject, parentId, {
      phase: "result",
      terminal: "executed",
      effect,
      evidence: { failures: [failureEvidence(error)], defects: [], interrupted: false },
      ...(callId === undefined ? {} : { callId }),
      ...(toolResult === undefined ? {} : { toolResult }),
    });
  }

  function publishToolStarted(request: ExecutionRequest): number | undefined {
    const identity = request.toolObservation;
    if (request.kind !== "tool" || identity === undefined) return undefined;
    const startedAt = options.clock();
    scopedObservations(identity).publish(Tool.Events.Started, {
      ...toolEventIdentity(request, identity),
      time: startedAt,
    });
    return startedAt;
  }

  function publishToolTerminal(
    request: ExecutionRequest,
    startedAt: number | undefined,
    status: ToolObservationStatus,
  ): void {
    const identity = request.toolObservation;
    if (request.kind !== "tool" || identity === undefined || startedAt === undefined) return;
    const observations = scopedObservations(identity);
    if (status === "timed_out") {
      observations.publish(Tool.Events.TimedOut, {
        ...toolEventIdentity(request, identity),
        time: options.clock(),
        timeoutMs: identity.timeoutMs ?? 0,
      });
    }
    const time = options.clock();
    observations.publish(Tool.Events.Completed, {
      ...toolEventIdentity(request, identity),
      time,
      durationMs: Math.max(0, time - startedAt),
      isError: status !== "success",
    });
  }

  function toolEventIdentity(request: ExecutionRequest, identity: ToolObservationIdentity) {
    return {
      traceId: identity.turnId,
      sessionId: options.identity.sessionId,
      runId: identity.turnId,
      toolCallId: identity.callId,
      toolName: request.op,
    };
  }

  function scopedObservations(identity: ToolObservationIdentity): ObservationSink | BusEvent.Sink {
    if (!("scope" in options.observations) || options.observations.scope === undefined) {
      return options.observations;
    }
    return options.observations.scope({
      traceId: identity.turnId,
      sessionId: options.identity.sessionId,
      turnId: identity.turnId,
      callId: identity.callId,
    });
  }

  function appendIntent(input: {
    readonly kind: LedgerAction.Kind;
    readonly op: string;
    readonly parentId: string | null;
    readonly value: PlainValue;
    readonly originalArgs?: PlainValue;
    readonly invocation?: PlainObject;
  }): Effect.Effect<LedgerAction.Receipt, CommitFailed> {
    return commit(
      actionAppend(
        input,
        {
          encodingVersion: 1,
          value: {
            phase: "intent",
            op: input.op,
            value: input.value,
            ...(input.originalArgs === undefined ? {} : { originalArgs: input.originalArgs }),
            ...input.invocation,
          },
        },
        { encodingVersion: 1, value: { phase: "pending" } },
      ),
    );
  }

  function appendResult(
    subject: ActionSubject,
    parentId: string,
    value: PlainValue,
    revert?: PlainValue,
  ): Effect.Effect<void, CommitFailed> {
    return Effect.suspend(() => {
      const action = actionAppend(
        { ...subject, parentId },
        { encodingVersion: 1, value: { phase: "result", op: subject.op } },
        { encodingVersion: 1, value },
      );
      if (revert === undefined) return Effect.asVoid(commit(action));
      return Effect.asVoid(commit({
        id: action.id,
        parentId: action.parentId,
        sessionId: action.sessionId,
        kind: action.kind,
        intent: action.intent,
        effect: action.effect,
        ts: action.ts,
        revert: { encodingVersion: 1, value: revert },
      }));
    });
  }

  function actionAppend(
    input: ActionSubject & { readonly parentId: string | null },
    intent: LedgerAction.Append["intent"],
    effect: LedgerAction.Append["effect"],
  ): LedgerAction.Append {
    return {
      id: options.entropy(),
      parentId: input.parentId,
      sessionId: options.identity.sessionId,
      kind: input.kind,
      intent,
      effect,
      ts: options.clock(),
      irreversible: true,
    };
  }

  return {
    commit,
    appendFailure,
    appendIntent,
    appendResult,
    publishToolStarted,
    publishToolTerminal,
  };
}

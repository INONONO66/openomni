import {
  L0Observation,
  Tool,
  type LedgerAction,
  type ObservationSink,
  type BusEvent,
  type PlainValue,
} from "@openomni/protocol";
import type { ExecutionRequest, ExecutorOptions } from "./executor";
import { waveBodyScope } from "./core/execution/tool-wave";
import { Run } from "@openomni/llm";

export type ToolObservationStatus = "success" | "error" | "timed_out";
type ToolObservationIdentity = NonNullable<ExecutionRequest["toolObservation"]>;
interface ActionSubject {
  readonly kind: LedgerAction.Kind;
  readonly op: string;
}

/** One record-before-observe adapter over the session's existing fenced ledger port. */
export function createExecutionRecord(
  options: Pick<ExecutorOptions, "ledger" | "observations" | "identity" | "clock" | "entropy">,
) {
  async function commit(action: LedgerAction.Append): Promise<LedgerAction.Receipt> {
    waveBodyScope.getStore()?.signal.throwIfAborted();
    const receipt = await options.ledger.commit(action);
    options.observations.publish(L0Observation.ActionCommittedEvent, {
      id: receipt.action.id,
      sessionId: receipt.action.sessionId,
      revision: receipt.revision,
      kind: receipt.action.kind,
    });
    return receipt;
  }

  async function appendFailure<Caught>(
    subject: ActionSubject,
    parentId: string,
    effect: PlainValue,
    caught: Caught,
    callId?: string,
  ): Promise<void> {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    await appendResult(subject, parentId, {
      phase: "result",
      terminal: "failed",
      effect,
      error: { name: error.name },
      ...(caught instanceof Run.FailureError ? { failure: caught.data } : {}),
      ...(callId === undefined ? {} : { callId }),
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

  async function appendIntent(input: {
    readonly kind: LedgerAction.Kind;
    readonly op: string;
    readonly parentId: string | null;
    readonly value: PlainValue;
  }): Promise<LedgerAction.Receipt> {
    return commit(
      actionAppend(
        input,
        {
          encodingVersion: 1,
          value: { phase: "intent", op: input.op, value: input.value },
        },
        { encodingVersion: 1, value: { phase: "pending" } },
      ),
    );
  }

  async function appendResult(
    subject: ActionSubject,
    parentId: string,
    value: PlainValue,
    revert?: PlainValue,
  ): Promise<void> {
    const action = actionAppend(
      { ...subject, parentId },
      { encodingVersion: 1, value: { phase: "result", op: subject.op } },
      { encodingVersion: 1, value },
    );
    if (revert === undefined) {
      await commit(action);
    } else {
      await commit({
        id: action.id,
        parentId: action.parentId,
        sessionId: action.sessionId,
        kind: action.kind,
        intent: action.intent,
        effect: action.effect,
        ts: action.ts,
        revert: { encodingVersion: 1, value: revert },
      });
    }
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

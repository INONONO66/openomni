import type {
  BusEvent,
  LedgerAction,
  LedgerSession,
  ObservationSink,
  PlainValue,
} from "@openomni/protocol";
import { L0Observation, Tool, canonicalDigest } from "@openomni/protocol";
import type {
  CompiledPolicySnapshot,
  PolicyEvaluation,
  PolicyEvaluationInput,
} from "@openomni/policy";

const CORE_KINDS = new Set(["prompt", "turn", "llm", "tool"]);
type ToolObservationStatus = "success" | "error" | "timed_out";

export class UnregisteredExecutionKindError extends Error {
  readonly code = "unregistered_execution_kind";

  constructor(readonly kind: string) {
    super(`unregistered execution kind: ${kind}`);
    this.name = "UnregisteredExecutionKindError";
  }
}

interface ExecutionKindRegistration {
  readonly kind: string;
  readonly effect: PlainValue;
  readonly reversible: boolean;
  readonly inputSchema: PlainValue;
}

export interface ExecutionLedger {
  commit(action: LedgerAction.Append): Promise<LedgerAction.Receipt>;
}

interface ExecutionIdentity {
  readonly sessionId: string;
  readonly role: LedgerSession.Role;
  readonly parentActionId: string | null;
}

interface ToolObservationIdentity {
  readonly turnId: string;
  readonly callId: string;
  readonly timeoutMs?: number;
}

interface ExecutionRequest {
  readonly kind: string;
  readonly op: string;
  readonly intent: PlainValue;
  readonly effect: PlainValue;
  readonly revert?: () => void | Promise<void>;
  readonly toolObservation?: ToolObservationIdentity;
}

interface AttemptRequest {
  readonly op: string;
  readonly intent: PlainValue;
  readonly effect: PlainValue;
}

interface ActionSubject {
  readonly kind: LedgerAction.Kind;
  readonly op: string;
}

type ExecutionResult =
  | { readonly terminal: "blocked_pre"; readonly reason: string }
  | { readonly terminal: "executed"; readonly value: PlainValue }
  | {
      readonly terminal: "blocked_post";
      readonly disposition: "reverted" | "irreversible";
      readonly reason: string;
    };

export interface Executor {
  run<T extends PlainValue>(
    request: ExecutionRequest,
    body: (intent: LedgerAction.Receipt) => Promise<T>,
  ): Promise<ExecutionResult>;
}

export interface DurableExecutor extends Executor {
  runExisting<T extends PlainValue>(
    request: ExecutionRequest,
    body: () => Promise<T>,
  ): Promise<ExecutionResult>;
  runAttempt<T extends PlainValue>(
    parent: LedgerAction.Receipt,
    request: AttemptRequest,
    body: () => Promise<T>,
  ): Promise<T>;
}

export interface ExecutorOptions {
  readonly policy: CompiledPolicySnapshot;
  readonly ledger: ExecutionLedger;
  readonly observations: ObservationSink | BusEvent.Sink;
  readonly identity: ExecutionIdentity;
  readonly clock: () => number;
  readonly entropy: () => string;
  readonly extensionKinds?: readonly ExecutionKindRegistration[];
}

export function createExecutor(options: ExecutorOptions): DurableExecutor {
  const kinds = new Set([
    ...CORE_KINDS,
    ...(options.extensionKinds ?? []).map((registration) => registration.kind),
  ]);

  async function commit(action: LedgerAction.Append): Promise<LedgerAction.Receipt> {
    const receipt = await options.ledger.commit(action);
    options.observations.publish(L0Observation.ActionCommittedEvent, {
      id: receipt.action.id,
      sessionId: receipt.action.sessionId,
      revision: receipt.revision,
      kind: receipt.action.kind,
    });
    return receipt;
  }

  async function decide(
    request: ExecutionRequest,
    phase: "pre" | "post",
    value: PlainValue,
  ): Promise<PolicyEvaluation> {
    const input: PolicyEvaluationInput = {
      kind: request.kind,
      phase,
      op: request.op,
      role: options.identity.role,
      sessionId: options.identity.sessionId,
      value,
    };
    const decision = options.policy.evaluate(input);
    await commit({
      id: options.entropy(),
      parentId: options.identity.parentActionId,
      sessionId: options.identity.sessionId,
      kind: "policy.decision",
      intent: {
        encodingVersion: 1,
        value: {
          hook: `${request.kind}.${phase}`,
          generation: decision.generation,
          matchedRuleIds: [...decision.matchedRuleIds],
          verdict: decision.verdict,
          inputHash: decision.inputHash,
        },
      },
      effect: {
        encodingVersion: 1,
        value: {
          phase: "result",
          reason: decision.reason ?? null,
        },
      },
      ts: options.clock(),
      irreversible: true,
    });
    return decision;
  }

  async function run<T extends PlainValue>(
    request: ExecutionRequest,
    body: (intent: LedgerAction.Receipt) => Promise<T>,
  ): Promise<ExecutionResult> {
    const kind = registeredKind(request);

    const pre = await decide(request, "pre", request.intent);
    const refusal = preRefusal(pre, false);
    if (refusal !== undefined) return refusal;

    const intent = await appendIntent({
      parentId: options.identity.parentActionId,
      kind,
      op: request.op,
      value: request.intent,
    });
    const startedAt = publishToolStarted(request);

    let value: T;
    try {
      value = await body(intent);
    } catch (caught) {
      await appendFailure({ kind, op: request.op }, intent.action.id, request.effect, caught);
      publishToolTerminal(request, startedAt, "error");
      throw caught;
    }
    const resultValue = clonePlainValue(value);
    const outcome = await applyPostPolicy(request, resultValue);
    return finishRun(request, kind, intent.action.id, startedAt, resultValue, outcome);
  }

  async function runExisting<T extends PlainValue>(
    request: ExecutionRequest,
    body: () => Promise<T>,
  ): Promise<ExecutionResult> {
    registeredKind(request);

    const pre = await decide(request, "pre", request.intent);
    const refusal = preRefusal(pre, true);
    if (refusal !== undefined) return refusal;

    return applyPostPolicy(request, clonePlainValue(await body()));
  }

  async function runAttempt<T extends PlainValue>(
    parent: LedgerAction.Receipt,
    request: AttemptRequest,
    body: () => Promise<T>,
  ): Promise<T> {
    const intent = await appendIntent({
      kind: "attempt",
      op: request.op,
      parentId: parent.action.id,
      value: request.intent,
    });
    const outcome = await body().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (caught) => ({ status: "rejected" as const, caught }),
    );
    if (outcome.status === "rejected") {
      await appendFailure(
        { kind: "attempt", op: request.op },
        intent.action.id,
        request.effect,
        outcome.caught,
      );
      throw outcome.caught;
    }
    await appendResult({ kind: "attempt", op: request.op }, intent.action.id, {
      phase: "result",
      terminal: "executed",
      effect: request.effect,
    });
    return outcome.value;
  }

  function registeredKind(request: ExecutionRequest): LedgerAction.Kind {
    if (!kinds.has(request.kind)) throw new UnregisteredExecutionKindError(request.kind);
    return request.kind as LedgerAction.Kind;
  }

  async function finishRun(
    request: ExecutionRequest,
    kind: LedgerAction.Kind,
    intentId: string,
    startedAt: number | undefined,
    resultValue: PlainValue,
    outcome: Exclude<ExecutionResult, { readonly terminal: "blocked_pre" }>,
  ): Promise<ExecutionResult> {
    const effect: PlainValue =
      outcome.terminal === "blocked_post"
        ? {
            phase: "result",
            terminal: outcome.terminal,
            disposition: outcome.disposition,
            reason: outcome.reason,
            effect: request.effect,
            resultHash: canonicalDigest(resultValue),
          }
        : {
            phase: "result",
            terminal: outcome.terminal,
            effect: request.effect,
            resultHash: canonicalDigest(outcome.value),
          };
    await appendResult({ kind, op: request.op }, intentId, effect);
    const status =
      outcome.terminal === "blocked_post" ? "error" : toolObservationStatus(outcome.value);
    publishToolTerminal(request, startedAt, status);
    return outcome;
  }

  async function appendFailure<Caught>(
    subject: ActionSubject,
    parentId: string,
    effect: PlainValue,
    caught: Caught,
  ): Promise<void> {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    await appendResult(subject, parentId, {
      phase: "result",
      terminal: "failed",
      effect,
      error: { name: error.name },
    });
  }

  async function applyPostPolicy(
    request: ExecutionRequest,
    resultValue: PlainValue,
  ): Promise<Exclude<ExecutionResult, { readonly terminal: "blocked_pre" }>> {
    const post = await decide(request, "post", {
      intent: request.intent,
      effect: request.effect,
      result: resultValue,
    });
    const transformed = resultFromEvaluation(post, resultValue);
    if (!blocks(post) && transformed.ok) {
      return { terminal: "executed", value: transformed.value };
    }
    const reason = transformed.ok ? (post.reason ?? "denied") : "invalid_output";
    const disposition = request.revert === undefined ? "irreversible" : "reverted";
    if (request.revert !== undefined) await request.revert();
    return { terminal: "blocked_post", disposition, reason };
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
  ): Promise<void> {
    await commit(
      actionAppend(
        { ...subject, parentId },
        { encodingVersion: 1, value: { phase: "result", op: subject.op } },
        { encodingVersion: 1, value },
      ),
    );
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

  return { run, runAttempt, runExisting };
}

function blocks(decision: PolicyEvaluation): boolean {
  return decision.verdict === "deny" || decision.verdict === "require_approval";
}

function preRefusal(
  decision: PolicyEvaluation,
  rejectTransform: boolean,
): Extract<ExecutionResult, { readonly terminal: "blocked_pre" }> | undefined {
  if (blocks(decision)) return { terminal: "blocked_pre", reason: decision.reason ?? "denied" };
  if (rejectTransform && decision.verdict === "transform") {
    return { terminal: "blocked_pre", reason: "invalid_input" };
  }
  return undefined;
}

function clonePlainValue(value: PlainValue): PlainValue {
  return JSON.parse(JSON.stringify(value)) as PlainValue;
}

function resultFromEvaluation(
  evaluation: PolicyEvaluation,
  fallback: PlainValue,
): { readonly ok: true; readonly value: PlainValue } | { readonly ok: false } {
  if (evaluation.verdict !== "transform") return { ok: true, value: fallback };
  const evaluated = evaluation.value;
  if (
    evaluated === null ||
    Array.isArray(evaluated) ||
    typeof evaluated !== "object" ||
    !("result" in evaluated)
  ) {
    return { ok: false };
  }
  return { ok: true, value: evaluated.result };
}

function toolObservationStatus(value: PlainValue): ToolObservationStatus {
  if (value === null || Array.isArray(value) || typeof value !== "object") return "error";
  if (value.status === "success" || value.status === "timed_out") return value.status;
  return "error";
}

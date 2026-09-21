import { SessionHandleStore } from "@openomni/ledger";
import { canonicalDigest, type LedgerAction, type PlainObject, type PlainValue } from "@openomni/protocol";
import type { PolicyEvaluation, PolicyEvaluationInput } from "@openomni/policy";
import { Cause, Chunk, Effect, Exit, Fiber, Option } from "effect";
import { findSessionRequest } from "./session-request";
import type { WaveControl } from "./core/execution/tool-wave";
import { createExecutionRecord, type ToolObservationStatus } from "./executor-record";
import { createExecutionApprovals } from "./executor-approval";
import { createExecutionRecovery, recoveryClassification } from "./executor-recovery";
import { createAttemptRunner } from "./executor-attempts";
import { createStopJudge } from "./executor-stop";
import { CommitFailed, ExecutionApprovalError, ForeignFailure, OutcomeUnknown, type ExecutionError } from "./errors";
import { causeEvidence } from "./executor-outcome";
import { createRawSlots, RawToolSlots } from "./executor-raw";
import { GenerationRawSlots } from "./session-generations";
import type {
  DurableExecutor, ExecutionBatchItem, ExecutionRequest,
  ExecutionResult, ExecutorOptions,
} from "./executor-contract";
export { ExecutionApprovalError } from "./errors";
export type {
  DurableExecutor, ExecutionLedger, Executor, ExecutionRequest, ExecutionApprovals,
  ExecutionApprovalRequest, ExecutionBatchResult, ExecutionResult, ExecutorOptions,
} from "./executor-contract";

const CORE_KINDS = new Set(["prompt", "turn", "llm", "tool", "compaction", "message"]);
type Decision = PolicyEvaluation & { readonly receipt: LedgerAction.Receipt };
type Stage<R> = {
  readonly item: ExecutionBatchItem<R>;
  readonly request: ExecutionRequest;
  readonly kind: LedgerAction.Kind;
  readonly pre: Decision;
  readonly intent: LedgerAction.Receipt | undefined;
};
type BodyExit = {
  readonly exit: Exit.Exit<PlainValue, ExecutionError>;
  readonly startedAt: number | undefined;
  readonly rawPending: boolean;
};

export function createExecutor(options: ExecutorOptions): DurableExecutor {
  const record = createExecutionRecord(options);
  const { approvals, awaitApproval } = createExecutionApprovals(options);
  const recovery = createExecutionRecovery(options, record);
  const kinds = new Set([...CORE_KINDS, ...(options.extensionKinds ?? []).map((item) => item.kind)]);
  const turnId = options.identity.turnId ?? options.identity.parentActionId;

  function decide(request: ExecutionRequest, phase: "pre" | "post", value: PlainValue,
    parentId = options.identity.parentActionId): Effect.Effect<Decision, CommitFailed> {
    return Effect.gen(function* () {
      const point = policyPoint(request, phase);
      const decision = options.policy.evaluate({
        ...point, role: options.identity.role, sessionId: options.identity.sessionId,
        ...(request.message === undefined ? {} : { message: request.message }), value,
      });
      const receipt = yield* record.commit({
        id: options.entropy(), parentId, sessionId: options.identity.sessionId, kind: "policy.decision",
        intent: { encodingVersion: 1, value: {
          hook: `${point.kind}.${point.phase}`, op: request.op, generation: decision.generation,
          matchedRuleIds: [...decision.matchedRuleIds], verdict: decision.verdict, inputHash: decision.inputHash,
        } },
        effect: { encodingVersion: 1, value: {
          phase: "result", reason: decision.reason ?? null,
          ...(decision.verdict === "deny" ? {
            terminal: phase === "pre" ? "blocked_pre" : "blocked_post",
            evidence: { failures: [{ tag: "PolicyDenied", phase, ruleIds: [...decision.matchedRuleIds] }], defects: [], interrupted: false },
          } : {}),
        } },
        ts: options.clock(), irreversible: true,
      });
      return { ...decision, receipt };
    });
  }

  function stageAll<R>(items: readonly ExecutionBatchItem<R>[]) {
    return Effect.gen(function* () {
      const staged = yield* Effect.forEach(items, (item) => Effect.gen(function* () {
        const request = { ...item.request, intent: structuredClone(item.request.intent) };
        if (!kinds.has(request.kind))
          return yield* new ForeignFailure({ operation: "executor.admit", cause: `unregistered_execution_kind:${request.kind}` });
        const kind = request.kind as LedgerAction.Kind;
        const pre = yield* decide(request, "pre", request.intent);
        return { item, request, kind, pre };
      }));
      return yield* Effect.forEach(staged, (stage) => Effect.gen(function* () {
        if (stage.pre.verdict === "deny") return { ...stage, intent: undefined };
        const original = stage.request.originalAction;
        if (original !== undefined) return { ...stage, intent: { action: original, revision: original.ordinal } };
        const intent = yield* record.appendIntent({
          parentId: options.identity.parentActionId, kind: stage.kind, op: stage.request.op, value: stage.pre.value,
          invocation: {
            effectHash: canonicalDigest(stage.request.effect), effect: stage.request.effect,
            callId: stage.request.toolObservation?.callId ?? stage.pre.receipt.action.id,
            turnId, waveId: staged[0]?.pre.receipt.action.id ?? stage.pre.receipt.action.id,
            sequential: stage.item.sequential ?? false, approvalRequired: needsApproval(stage),
            domainRevisions: { ...stage.request.approval?.domainRevisions }, recovery: recoveryClassification(stage.request),
            toolsGeneration: options.identity.toolsGeneration ?? null,
            systemHash: options.identity.systemHash ?? null,
          },
        });
        return { ...stage, intent };
      }));
    });
  }

  function approval<R>(stage: Stage<R>, signal: AbortSignal) {
    const intent = stage.intent;
    const original = intent === undefined ? undefined : findSessionRequest(options.ledger.actions?.() ?? [], intent.action.id);
    if (intent === undefined || (!needsApproval(stage) && original === undefined))
      return Effect.succeed("approve" as const);
    return awaitApproval({
      id: intent.action.id, sessionId: options.identity.sessionId, turnId,
      toolsHash: options.identity.toolsHash, toolsGeneration: options.identity.toolsGeneration,
      callId: stage.request.toolObservation?.callId ?? intent.action.id,
      inputHash: canonicalDigest(stage.request.intent), generation: stage.pre.generation,
      revision: stage.pre.receipt.revision, policyDecisionId: stage.pre.receipt.action.id, intent: stage.request.intent,
    }, signal, {
      effect: stage.request.effect, domainRevisions: stage.request.approval?.domainRevisions,
      revisions: stage.request.domainRevisions, timeoutMs: stage.request.approval?.timeoutMs, original,
    });
  }

  function admittedBody<R>(stage: Stage<R>, guarded: boolean, started: () => void) {
    return Effect.gen(function* () {
      const intent = stage.intent;
      if (intent === undefined) return yield* Effect.die("missing admitted intent");
      const captured = findSessionRequest(options.ledger.actions?.() ?? [], intent.action.id);
      assertFresh(stage.request, captured);
      if (guarded) {
        const id = `${intent.action.id}:application`;
        if (options.ledger.actions?.().some((action) => action.id === id))
          return yield* new OutcomeUnknown({ reason: "application_already_entered" });
        yield* record.commit({
          id, parentId: intent.action.id, sessionId: options.identity.sessionId, kind: stage.kind,
          intent: { encodingVersion: 1, value: { phase: "application", op: stage.request.op } },
          effect: { encodingVersion: 1, value: { phase: "application", inputHash: canonicalDigest(stage.request.intent) } },
          ts: options.clock(), irreversible: true,
        });
      }
      assertFresh(stage.request, captured);
      if (captured !== undefined && options.ledger.validateRequest?.(captured) === false)
        return yield* new ExecutionApprovalError({ code: "stale_approval" });
      started();
      return yield* stage.item.body(intent);
    });
  }

  function executeBody<R>(stage: Stage<R>, signal: AbortSignal, guarded: boolean) {
    return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const generation = yield* Effect.serviceOption(GenerationRawSlots);
      const slots = createRawSlots((settlement) => {
        if (Option.isSome(generation)) {
          const release = generation.value.open();
          void settlement.then(release);
        }
        options.retainEffect?.(settlement);
      });
      let startedAt: number | undefined;
      const body = admittedBody(stage, guarded, () => { startedAt = record.publishToolStarted(stage.request); });
      const owned = Effect.scoped(body.pipe(Effect.provideService(RawToolSlots, slots)));
      const fiber = yield* Effect.fork(Effect.interruptible(withSignal(owned, signal)));
      const awaited = yield* Effect.exit(restore(Fiber.join(fiber)));
      const exit = Exit.isFailure(awaited) && Cause.isInterrupted(awaited.cause)
        ? yield* Fiber.interrupt(fiber) : awaited;
      if (slots.pending() > 0) {
        yield* Effect.interruptible(slots.awaitSettled).pipe(Effect.timeoutOption(options.closeGraceMs ?? SessionHandleStore.LEASE_TTL_MS));
      }
      return { exit, startedAt, rawPending: slots.pending() > 0 } satisfies BodyExit;
    }));
  }

  function appendOutcome<R>(stage: Stage<R>, outcome: ExecutionResult, evidence: PlainObject = {}, project = true) {
    return Effect.gen(function* () {
      if (stage.intent !== undefined) {
        yield* record.appendResult({ kind: stage.kind, op: stage.request.op }, stage.intent.action.id, {
          phase: "result", terminal: outcome.terminal, effect: stage.request.effect,
          ...evidence,
          ...(outcome.terminal === "executed" ? { result: outcome.value, resultHash: canonicalDigest(outcome.value) }
            : { reason: outcome.reason }),
          ...(outcome.terminal === "blocked_post" ? { disposition: outcome.disposition } : {}),
          ...(stage.request.toolObservation === undefined ? {} : { callId: stage.request.toolObservation.callId }),
          ...(!project || stage.request.toolResult === undefined ? {} : { toolResult: stage.request.toolResult(outcome) }),
        }, outcome.terminal === "executed" && outcome.failure === undefined ? stage.request.revertData?.() : undefined);
      }
      return outcome;
    });
  }

  function finishBody<R>(stage: Stage<R>, body: BodyExit): Effect.Effect<ExecutionResult, ExecutionError> {
    return Effect.gen(function* () {
      const { exit } = body;
      let outcome: ExecutionResult;
      if (body.rawPending) {
        outcome = { terminal: "outcome_unknown", reason: "raw_body_unsettled_after_grace" };
        yield* appendOutcome(stage, outcome, {
          evidence: Exit.isFailure(exit) ? causeEvidence(exit.cause) : { failures: [], defects: [], interrupted: false },
        });
      } else if (Exit.isFailure(exit)) {
        const commitFailure = Chunk.toReadonlyArray(Cause.failures(exit.cause)).find((error) => error._tag === "CommitFailed");
        if (commitFailure !== undefined) return yield* commitFailure;
        const failure = Option.getOrElse(Cause.failureOption(exit.cause), () =>
          new ForeignFailure({ operation: stage.request.op, cause: Cause.pretty(exit.cause) }));
        outcome = Cause.isInterrupted(exit.cause) || failure._tag === "Interrupted"
          ? { terminal: "interrupted", reason: "fiber_interrupted" }
          : failure._tag === "OutcomeUnknown"
            ? { terminal: "outcome_unknown", reason: failure.reason }
            : { terminal: "executed", value: null, failure };
        yield* appendOutcome(stage, outcome, { evidence: causeEvidence(exit.cause) });
      } else {
        outcome = yield* complete(stage, exit.value).pipe(
          Effect.catchAllCause((cause) => completionFailure(stage, exit.value, cause)),
        );
      }
      record.publishToolTerminal(stage.request, body.startedAt, terminalStatus(outcome));
      return outcome;
    });
  }

  function completionFailure<R>(stage: Stage<R>, value: PlainValue, cause: Cause.Cause<ExecutionError>) {
    const failures = Chunk.toReadonlyArray(Cause.failures(cause));
    if (failures.some((error) => error._tag === "CommitFailed")) return Effect.failCause(cause);
    const terminalExists = options.ledger.actions?.().some((action) =>
      action.parentId === stage.intent?.action.id && object(action.effect.value).phase === "result");
    if (terminalExists) return Effect.failCause(cause);
    const failure = Option.getOrElse(Cause.failureOption(cause), () =>
      new ForeignFailure({ operation: `${stage.request.op}.completion`, cause: Cause.pretty(cause) }));
    return appendOutcome(stage, { terminal: "executed", value, failure }, {
      disposition: "irreversible", evidence: causeEvidence(cause),
    }, false);
  }

  function complete<R>(stage: Stage<R>, value: PlainValue): Effect.Effect<ExecutionResult, ExecutionError> {
    return Effect.gen(function* () {
      const post = yield* decide(stage.request, "post", { intent: stage.request.intent, effect: stage.request.effect, result: value });
      const outcome = yield* settlePost(stage.request, post, value);
      if (stage.request.boundary === true && outcome.terminal === "executed" && stage.intent !== undefined) {
        yield* record.commit({
          id: `${stage.intent.action.id}:boundary`, parentId: stage.intent.action.id,
          sessionId: options.identity.sessionId, kind: stage.kind,
          intent: { encodingVersion: 1, value: { phase: "boundary", op: stage.request.op } },
          effect: { encodingVersion: 1, value: { phase: "boundary", result: outcome.value, resultHash: canonicalDigest(outcome.value) } },
          ts: options.clock(), irreversible: true,
        });
      }
      return yield* appendOutcome(stage, outcome);
    });
  }

  function runBatch<R>(items: readonly ExecutionBatchItem<R>[], control: WaveControl) {
    return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, control.signal, ...(options.signal === undefined ? [] : [options.signal])]);
      const stages = yield* stageAll(items);
      const decisions = yield* Effect.forEach(stages, (stage) => restore(approval(stage, signal)), { concurrency: "unbounded" });
      const guarded = stages.some((stage) => needsApproval(stage) || stage.request.originalAction !== undefined);
      const exits = new Map<number, BodyExit>();
      const group: Fiber.RuntimeFiber<BodyExit, never>[] = [];
      const join = Effect.suspend(() => Effect.gen(function* () {
        const waiting = Effect.forEach(group, Fiber.join, { discard: true });
        const exit = yield* Effect.exit(restore(waiting));
        if (Exit.isFailure(exit)) {
          controller.abort();
          yield* waiting;
        }
      }));
      for (const [index, stage] of stages.entries()) {
        if (stage.pre.verdict === "deny" || decisions[index] !== "approve") continue;
        if (stage.item.sequential) { yield* join; group.length = 0; }
        const work = executeBody(stage, signal, guarded).pipe(Effect.tap((result) => Effect.sync(() => exits.set(index, result))));
        const fiber = yield* Effect.fork(work);
        group.push(fiber);
        if (stage.item.sequential) { yield* join; group.length = 0; }
      }
      yield* join;
      return yield* Effect.forEach(stages, (stage, index) => {
        if (stage.pre.verdict === "deny" || decisions[index] !== "approve") {
          return appendOutcome(stage, {
            terminal: "blocked_pre",
            reason: stage.pre.verdict === "deny" ? stage.pre.reason ?? "denied"
              : decisions[index] === "timeout" ? "approval_timeout" : "approval_refused",
          });
        }
        const body = exits.get(index);
        return body === undefined ? Effect.die("missing action fiber exit") : finishBody(stage, body);
      });
    }));
  }

  function run<T extends PlainValue, R>(request: ExecutionRequest,
    body: (intent: LedgerAction.Receipt) => Effect.Effect<T, ExecutionError, R>) {
    return runBatch([{ request, body }], { signal: options.signal ?? new AbortController().signal }).pipe(
      Effect.flatMap((results) => {
        const result = results[0];
        if (result === undefined) return Effect.die("missing execution outcome");
        return result.terminal === "executed" && result.failure !== undefined
          ? Effect.fail(result.failure) : Effect.succeed(result);
      }),
    );
  }

  function runExisting<T extends PlainValue, R>(request: ExecutionRequest, body: () => Effect.Effect<T, ExecutionError, R>) {
    return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const pre = yield* decide(request, "pre", request.intent);
      if (pre.verdict !== "allow") return { terminal: "blocked_pre", reason: pre.reason ?? "denied" } as const;
      const exit = yield* Effect.exit(restore(Effect.scoped(body())));
      if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
      const post = yield* decide(request, "post", { intent: request.intent, effect: request.effect, result: exit.value });
      return yield* settlePost(request, post, exit.value);
    }));
  }

  const runAttempts = createAttemptRunner(options, record,
    (request, parent) => decide({ kind: "llm", ...request }, "pre", request.intent, parent.action.id),
    (request, intent, pre) => awaitApproval({
      id: intent.action.id, sessionId: options.identity.sessionId, turnId,
      toolsHash: options.identity.toolsHash, toolsGeneration: options.identity.toolsGeneration,
      callId: intent.action.id, inputHash: canonicalDigest(request.intent), generation: pre.generation,
      revision: pre.receipt.revision, policyDecisionId: pre.receipt.action.id, intent: request.intent,
    }, options.signal ?? new AbortController().signal, { effect: request.effect }));
  const judgeStop = createStopJudge(options,
    (op, value) => decide({ kind: "turn", op, intent: value, effect: {} }, "post", value), record.commit);
  return { run, runBatch, runExisting, runAttempts, judgeStop, approvals, recover: recovery.recover };
}

function policyPoint(request: ExecutionRequest, phase: "pre" | "post"): Pick<PolicyEvaluationInput, "kind" | "phase" | "op"> {
  return request.kind === "compaction"
    ? { kind: "turn", phase: "post", op: request.op === "compact" ? "compaction" : request.op }
    : { kind: request.kind, phase, op: request.op };
}
function needsApproval(stage: { readonly pre: PolicyEvaluation; readonly request: ExecutionRequest }) {
  return stage.pre.verdict === "require_approval" || stage.request.approval?.required === true;
}
function assertFresh(request: ExecutionRequest, captured: ReturnType<typeof findSessionRequest>): void {
  if (captured !== undefined && request.domainRevisions !== undefined &&
      canonicalDigest({ ...request.domainRevisions() }) !== canonicalDigest(captured.domainRevisions))
    throw new ExecutionApprovalError({ code: "stale_approval" });
}
function withSignal<A, E, R>(effect: Effect.Effect<A, E, R>, signal: AbortSignal) {
  const abort = Effect.async<never>((resume) => {
    const listener = () => resume(Effect.interrupt);
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
    return Effect.sync(() => signal.removeEventListener("abort", listener));
  });
  return signal.aborted ? Effect.interrupt : effect.pipe(Effect.raceFirst(abort));
}
function settlePost(request: ExecutionRequest, post: PolicyEvaluation, value: PlainValue): Effect.Effect<ExecutionResult, ExecutionError> {
  return Effect.gen(function* () {
    const transformed = post.verdict === "transform" ? object(post.value).result : value;
    if (post.verdict !== "deny" && post.verdict !== "require_approval" && transformed !== undefined)
      return { terminal: "executed", value: transformed } as const;
    if (request.revert !== undefined) yield* request.revert();
    return { terminal: "blocked_post", disposition: request.revert === undefined ? "irreversible" : "reverted",
      reason: transformed === undefined ? "invalid_output" : post.reason ?? "denied" } as const;
  });
}
function object(value: PlainValue): PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function terminalStatus(outcome: ExecutionResult): ToolObservationStatus {
  if (outcome.terminal !== "executed" || outcome.failure !== undefined) return "error";
  const status = object(outcome.value).status;
  return status === "success" || status === "timed_out" ? status : "error";
}

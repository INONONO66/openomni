import { SessionHandleStore } from "@openomni/ledger";
import { canonicalDigest, SessionHistory, type LedgerAction, type PlainObject, type PlainValue } from "@openomni/protocol";
import type { PolicyEvaluation, PolicyEvaluationInput } from "@openomni/policy";
import { Cause, Chunk, Context, Effect, Exit, Fiber, Option, Scope } from "effect";
import { findSessionRequest } from "./session-request";
import type { WaveControl } from "./core/execution/tool-wave";
import { createExecutionRecord, type ToolObservationStatus } from "./executor-record";
import { createExecutionApprovals } from "./executor-approval";
import { createExecutionRecovery, recoveryClassification } from "./executor-recovery";
import { createAttemptRunner } from "./executor-attempts";
import { createStopJudge } from "./executor-stop";
import { type CommitFailed, ExecutionApprovalError, ForeignFailure, Interrupted, OutcomeUnknown, type ExecutionError } from "./errors";
import { causeEvidence } from "./executor-outcome";
import { createRawSlots, RawToolSlots } from "./executor-raw";
import { GenerationRawSlots } from "./session-generations";
import { Clock, Entropy, ObservationSink, SessionLayer, type ProcessServices } from "./services";
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
type Admission = Pick<Decision, "generation" | "receipt" | "verdict" | "value" | "reason" | "transforms">;
type Restore = Parameters<Parameters<typeof Effect.uninterruptibleMask>[0]>[0];
type Stage<R> = {
  readonly item: ExecutionBatchItem<R>;
  readonly request: ExecutionRequest;
  readonly kind: LedgerAction.Kind;
  readonly pre: Admission;
  readonly intent: LedgerAction.Receipt | undefined;
};
type BodyExit = {
  readonly exit: Exit.Exit<PlainValue, ExecutionError>;
  readonly startedAt: number | undefined;
  readonly rawPending: boolean;
};

function combinedSignal(controller: AbortSignal, control: AbortSignal, caller: AbortSignal | undefined): AbortSignal {
  return AbortSignal.any(caller === undefined ? [controller, control] : [controller, control, caller]);
}

function outcomeFields(outcome: ExecutionResult): PlainObject {
  if (outcome.terminal === "executed") return { result: outcome.value, resultHash: canonicalDigest(outcome.value) };
  return outcome.terminal === "blocked_post" ? { reason: outcome.reason, disposition: outcome.disposition } : { reason: outcome.reason };
}
function failedOutcome(cause: Cause.Cause<ExecutionError>, failure: ExecutionError): ExecutionResult {
  if (Cause.isInterrupted(cause) || failure._tag === "Interrupted") return { terminal: "interrupted", reason: "fiber_interrupted" };
  return failure._tag === "OutcomeUnknown"
    ? { terminal: "outcome_unknown", reason: failure.reason }
    : { terminal: "executed", value: null, failure };
}

export function createExecutor(input: ExecutorOptions): Effect.Effect<DurableExecutor, ExecutionError, ProcessServices | SessionLayer> {
  return Effect.gen(function* () {
  if (input.approvalTimeoutMs !== undefined && (!Number.isSafeInteger(input.approvalTimeoutMs) || input.approvalTimeoutMs < 0))
    return yield* new ForeignFailure({ operation: "executor.acquire", cause: "invalid_approval_timeout" });
  const clock = yield* Clock;
  const entropy = yield* Entropy;
  const observations = yield* ObservationSink;
  const { policy } = yield* SessionLayer;
  const options = { ...input, clock: clock.now, entropy: entropy.next, observations, policy };
  const record = createExecutionRecord(options);
  const { approvals, awaitApproval } = createExecutionApprovals(options);
  const recovery = createExecutionRecovery(options, record);
  const kinds = new Set([...CORE_KINDS, ...(options.extensionKinds ?? []).map((item) => item.kind)]);
  const turnId = options.identity.turnId ?? options.identity.parentActionId;

  function decide(request: ExecutionRequest, phase: "pre" | "post", value: PlainValue,
    parentId = options.identity.parentActionId): Effect.Effect<Decision, CommitFailed> {
    return Effect.suspend(() => {
      const point = policyPoint(request, phase);
      const decision = options.policy.evaluate({
        ...point, role: options.identity.role, sessionId: options.identity.sessionId,
        ...(request.message === undefined ? {} : { message: request.message }), value,
      });
      return record.commit({
        id: options.entropy(), parentId, sessionId: options.identity.sessionId, kind: "policy.decision",
        intent: { encodingVersion: 1, value: {
          hook: `${point.kind}.${point.phase}`, op: request.op, generation: decision.generation,
          matchedRuleIds: [...decision.matchedRuleIds], verdict: decision.verdict, inputHash: decision.inputHash,
          transforms: decision.transforms.map((transform) => ({ ...transform })),
          ...(decision.ref === undefined ? {} : { ref: decision.ref }),
        } },
        effect: { encodingVersion: 1, value: {
          phase: "result", reason: decision.reason ?? null,
          ...(decision.verdict === "deny" ? {
            terminal: phase === "pre" ? "blocked_pre" : "blocked_post",
            evidence: { failures: [{ tag: "PolicyDenied", phase, ruleIds: [...decision.matchedRuleIds] }], defects: [], interrupted: false },
          } : {}),
        } },
        ts: options.clock(), irreversible: true,
      }).pipe(Effect.map((receipt) => ({ ...decision, receipt })));
    });
  }

  function invocationFor<R>(stage: Omit<Stage<R>, "intent">, waveId: string) {
    return {
      policyDecisionId: stage.pre.receipt.action.id,
      effectHash: canonicalDigest(stage.request.effect), effect: stage.request.effect,
      callId: stage.request.toolObservation?.callId ?? stage.pre.receipt.action.id,
      turnId, waveId,
      sequential: stage.item.sequential ?? false, approvalRequired: needsApproval(stage),
      domainRevisions: { ...stage.request.approval?.domainRevisions }, recovery: recoveryClassification(stage.request),
      toolsGeneration: options.identity.toolsGeneration ?? null,
      systemHash: options.identity.systemHash ?? null,
    };
  }

  function admit(request: ExecutionRequest): Effect.Effect<Admission, ExecutionError> {
    const original = request.originalAction;
    if (original === undefined) return decide(request, "pre", request.intent);
    return Effect.try({ try: () => {
      const intent = object(original.intent.value);
      const inputHash = canonicalDigest({ ...policyPoint(request, "pre"), role: options.identity.role,
        sessionId: options.identity.sessionId, ...(request.message === undefined ? {} : { message: request.message }), value: request.intent });
      const action = recordedDecision(options.ledger.actions?.() ?? [], original, intent.policyDecisionId, inputHash);
      if (action === undefined || intent.value === undefined) throw new ExecutionApprovalError({ code: "stale_approval" });
      const recorded = SessionHistory.PolicyDecision.parse({ ...object(action.intent.value),
        revision: action.ordinal, actionId: action.id, subjectActionId: action.parentId, turnId: options.identity.turnId ?? null,
        reason: object(action.effect.value).reason ?? null,
      });
      if (recorded.inputHash !== inputHash || recorded.generation !== options.policy.generation ||
          recorded.hook !== `${policyPoint(request, "pre").kind}.pre` || recorded.op !== request.op)
        throw new ExecutionApprovalError({ code: "stale_approval" });
      return { generation: recorded.generation, verdict: recordedVerdict(recorded.verdict), transforms: recorded.transforms,
        value: intent.value, ...(recorded.reason === null ? {} : { reason: recorded.reason }),
        receipt: { action, revision: action.ordinal } };
    }, catch: (cause) => cause instanceof ExecutionApprovalError ? cause : new ForeignFailure({ operation: "executor.recover_admission", cause: String(cause) }) });
  }

  /** Denied stages record nothing; recovered stages reuse the original intent; fresh stages append one. */
  function stageIntent<R>(stage: Omit<Stage<R>, "intent">, waveId: string): Effect.Effect<LedgerAction.Receipt | undefined, ExecutionError> {
    const original = stage.request.originalAction;
    if (stage.pre.verdict === "deny") return Effect.succeed(undefined);
    if (original !== undefined) return Effect.succeed({ action: original, revision: original.ordinal });
    return record.appendIntent({
      parentId: options.identity.parentActionId, kind: stage.kind, op: stage.request.op, value: stage.pre.value,
      ...(stage.pre.transforms.length === 0 ? {} : { originalArgs: stage.request.intent }),
      invocation: invocationFor(stage, waveId),
    });
  }

  function stageAll<R>(items: readonly ExecutionBatchItem<R>[]): Effect.Effect<Stage<R>[], ExecutionError> {
    const [item] = items;
    if (items.length === 1 && item !== undefined) {
      return Effect.suspend<Stage<R>[], ExecutionError, never>(() => {
        const request = { ...item.request, intent: structuredClone(item.request.intent) };
        if (!kinds.has(request.kind))
          return Effect.fail(new ForeignFailure({ operation: "executor.admit", cause: `unregistered_execution_kind:${request.kind}` }));
        const kind = request.kind as LedgerAction.Kind;
        return admit(request).pipe(Effect.flatMap((pre) => {
          const stage = { item, request, kind, pre };
          return stageIntent(stage, pre.receipt.action.id).pipe(Effect.map((receipt) => [{ ...stage, intent: receipt }]));
        }));
      });
    }
    return Effect.gen(function* () {
      const staged: Omit<Stage<R>, "intent">[] = [];
      for (const item of items) {
        const request = { ...item.request, intent: structuredClone(item.request.intent) };
        if (!kinds.has(request.kind))
          return yield* new ForeignFailure({ operation: "executor.admit", cause: `unregistered_execution_kind:${request.kind}` });
        const kind = request.kind as LedgerAction.Kind;
        const pre = yield* admit(request);
        staged.push({ item, request, kind, pre });
      }
      const admitted: Stage<R>[] = [];
      for (const stage of staged) {
        const intent = yield* stageIntent(stage, staged[0]?.pre.receipt.action.id ?? stage.pre.receipt.action.id);
        admitted.push({ ...stage, intent });
      }
      return admitted;
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
    return Effect.suspend<PlainValue, ExecutionError, R>(() => {
      const intent = stage.intent;
      if (intent === undefined) return Effect.die("missing admitted intent");
      const captured = findSessionRequest(options.ledger.actions?.() ?? [], intent.action.id);
      assertFresh(stage.request, captured);
      const enter = (): Effect.Effect<PlainValue, ExecutionError, R> => {
        assertFresh(stage.request, captured);
        if (captured !== undefined && options.ledger.validateRequest?.(captured) === false)
          return Effect.fail(new ExecutionApprovalError({ code: "stale_approval" }));
        started();
        const admitted = object(intent.action.intent.value).value;
        if (admitted === undefined) return Effect.die("missing admitted input");
        return stage.item.body(intent, immutableInput(structuredClone(admitted)));
      };
      if (!guarded) return enter();
      const id = `${intent.action.id}:application`;
      if (options.ledger.actions?.().some((action) => action.id === id))
        return Effect.fail(new OutcomeUnknown({ reason: "application_already_entered" }));
      return record.commit({
        id, parentId: intent.action.id, sessionId: options.identity.sessionId, kind: stage.kind,
        intent: { encodingVersion: 1, value: { phase: "application", op: stage.request.op } },
        effect: { encodingVersion: 1, value: { phase: "application", inputHash: canonicalDigest(stage.request.intent) } },
        ts: options.clock(), irreversible: true,
      }).pipe(Effect.flatMap(enter));
    });
  }

  function executeBody<R>(stage: Stage<R>, signal: AbortSignal, guarded: boolean, settled: (body: BodyExit) => void) {
    return Effect.withFiberRuntime<void, never, Exclude<R, RawToolSlots | Scope.Scope>>((fiber) => Effect.uninterruptible(
      Effect.suspend(() => {
        const generation = Context.getOption(fiber.currentContext, GenerationRawSlots);
        const slots = createRawSlots((settlement) => {
          if (Option.isSome(generation)) {
            const release = generation.value.open();
            void settlement.then(release);
          }
          options.retainEffect?.(settlement);
        });
        let startedAt: number | undefined;
        const body = admittedBody(stage, guarded, () => { startedAt = record.publishToolStarted(stage.request); });
        const owned = Effect.scopedWith((scope) => Effect.provide(
          body, Context.make(RawToolSlots, slots).pipe(Context.add(Scope.Scope, scope)),
        ));
        const abort = () => fiber.unsafeInterruptAsFork(fiber.id());
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        const exitEffect = Effect.exit(Effect.interruptible(owned)).pipe(
          Effect.flatMap((exit) => {
            signal.removeEventListener("abort", abort);
            if (slots.pending() === 0) return Effect.succeed(exit);
            const grace = Effect.fork(Effect.interruptible(slots.awaitSettled).pipe(
              Effect.timeoutOption(options.closeGraceMs ?? SessionHandleStore.LEASE_TTL_MS),
            ));
            return grace.pipe(Effect.flatMap(Fiber.join), Effect.as(exit));
          }),
        );
        if (options.retainEffect === undefined)
          return exitEffect.pipe(Effect.flatMap((exit) => Effect.sync(() => {
            settled({ exit, startedAt, rawPending: slots.pending() > 0 });
          })));
        let completed: BodyExit | undefined;
        const settle = (body: BodyExit) => {
          if (completed !== undefined) return;
          completed = body;
          settled(body);
        };
        return exitEffect.pipe(
          Effect.flatMap((exit) => Effect.sync(() => {
            settle({ exit, startedAt, rawPending: slots.pending() > 0 });
          })),
          Effect.ensuring(Effect.sync(() => {
            if (completed === undefined)
              settle({ exit: Exit.fail(new Interrupted()), startedAt, rawPending: slots.pending() > 0 });
          })),
        );
      }),
    ));
  }

  function appendOutcome<R>(stage: Stage<R>, outcome: ExecutionResult, evidence: PlainObject = {}, project = true) {
    return Effect.suspend(() => {
      if (stage.intent !== undefined) {
        return record.appendResult({ kind: stage.kind, op: stage.request.op }, stage.intent.action.id, {
          phase: "result", terminal: outcome.terminal, effect: stage.request.effect,
          ...evidence,
          ...outcomeFields(outcome),
          ...(stage.request.toolObservation === undefined ? {} : { callId: stage.request.toolObservation.callId }),
          ...(!project || stage.request.toolResult === undefined ? {} : { toolResult: stage.request.toolResult(outcome) }),
        }, outcome.terminal === "executed" && outcome.failure === undefined ? stage.request.revertData?.() : undefined).pipe(Effect.as(outcome));
      }
      return Effect.succeed(outcome);
    });
  }

  function finishBody<R>(stage: Stage<R>, body: BodyExit): Effect.Effect<ExecutionResult, ExecutionError> {
    return Effect.suspend(() => {
      const { exit } = body;
      if (body.rawPending) {
        return appendOutcome(stage, { terminal: "outcome_unknown", reason: "raw_body_unsettled_after_grace" }, {
          evidence: Exit.isFailure(exit) ? causeEvidence(exit.cause) : { failures: [], defects: [], interrupted: false },
        });
      }
      if (Exit.isFailure(exit)) {
        const commitFailure = Chunk.toReadonlyArray(Cause.failures(exit.cause)).find((error) => error._tag === "CommitFailed");
        if (commitFailure !== undefined) return Effect.fail(commitFailure);
        const failure = Option.getOrElse(Cause.failureOption(exit.cause), () =>
          new ForeignFailure({ operation: stage.request.op, cause: Cause.pretty(exit.cause) }));
        return appendOutcome(stage, failedOutcome(exit.cause, failure), { evidence: causeEvidence(exit.cause) });
      }
      return complete(stage, exit.value).pipe(
        Effect.catchAllCause((cause) => completionFailure(stage, exit.value, cause)),
      );
    }).pipe(Effect.map((outcome) => {
      record.publishToolTerminal(stage.request, body.startedAt, terminalStatus(outcome));
      return outcome;
    }));
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

  function complete<R>(stage: Stage<R>, raw: PlainValue): Effect.Effect<ExecutionResult, ExecutionError> {
    return Effect.gen(function* () {
      const value = clonePlainValue(raw);
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

  function finishStage<R>(stage: Stage<R>, decision: "approve" | "refuse" | "timeout" | undefined, body: BodyExit | undefined) {
    if (stage.pre.verdict !== "deny" && decision === "approve")
      return body === undefined ? Effect.die("missing action fiber exit") : finishBody(stage, body);
    return appendOutcome(stage, {
      terminal: "blocked_pre",
      reason: stage.pre.verdict === "deny" ? stage.pre.reason ?? "denied"
        : decision === "timeout" ? "approval_timeout" : "approval_refused",
    });
  }

  function runSingle<R>(single: Stage<R>, signal: AbortSignal, controller: AbortController, restore: Restore) {
    return approval(single, signal).pipe(Effect.flatMap((decision) => {
      if (single.pre.verdict === "deny" || decision !== "approve")
        return finishStage(single, decision, undefined).pipe(Effect.map((result) => [result]));
      let body: BodyExit | undefined;
      return Effect.fork(executeBody(single, signal, false, (result) => { body = result; })).pipe(
        Effect.flatMap((fiber) => Effect.exit(restore(Fiber.await(fiber))).pipe(
          Effect.flatMap((awaited) => Exit.isFailure(awaited)
            ? Effect.sync(() => controller.abort()).pipe(Effect.flatMap(() => Fiber.await(fiber)))
            : Effect.void),
          Effect.flatMap(() => finishStage(single, decision, body)),
          Effect.map((result) => [result]),
        )),
      );
    }));
  }

  function runStages<R>(stages: readonly Stage<R>[], signal: AbortSignal, controller: AbortController, guarded: boolean, restore: Restore) {
    return Effect.gen(function* () {
      const decisions = yield* Effect.forEach(stages, (stage) => restore(approval(stage, signal)), { concurrency: "unbounded" });
      const exits = new Map<number, BodyExit>();
      const group: Fiber.RuntimeFiber<void, never>[] = [];
      const join = Effect.suspend(() => Effect.gen(function* () {
        const waiting = Effect.forEach(group, Fiber.await, { discard: true });
        const exit = yield* Effect.exit(restore(waiting));
        if (Exit.isFailure(exit)) {
          controller.abort();
          yield* waiting;
        }
      }));
      const shouldExecute = (stage: Stage<R>, index: number) => stage.pre.verdict !== "deny" && decisions[index] === "approve";
      for (const [index, stage] of stages.entries()) {
        if (!shouldExecute(stage, index)) continue;
        if (stage.item.sequential) { yield* join; group.length = 0; }
        const work = executeBody(stage, signal, guarded, (result) => { exits.set(index, result); });
        const fiber = yield* Effect.fork(work);
        group.push(fiber);
        if (stage.item.sequential) { yield* join; group.length = 0; }
      }
      yield* join;
      return yield* Effect.forEach(stages, (stage, index) => finishStage(stage, decisions[index], exits.get(index)));
    });
  }

  function runBatch<R>(items: readonly ExecutionBatchItem<R>[], control: WaveControl): Effect.Effect<readonly ExecutionResult[], ExecutionError, Exclude<R, RawToolSlots | Scope.Scope>> {
    return Effect.uninterruptibleMask((restore) => {
      const controller = new AbortController();
      const signal = combinedSignal(controller.signal, control.signal, options.signal);
      return stageAll(items).pipe(Effect.flatMap((stages) => {
        const guarded = stages.some((stage) => needsApproval(stage) || stage.request.originalAction !== undefined);
        const single = stages.length === 1 ? stages[0] : undefined;
        return single !== undefined && !guarded
          ? runSingle(single, signal, controller, restore)
          : runStages(stages, signal, controller, guarded, restore);
      }));
    });
  }

  function run<T extends PlainValue, R>(request: ExecutionRequest,
    body: (intent: LedgerAction.Receipt, admittedInput: PlainValue) => Effect.Effect<T, ExecutionError, R>) {
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
      const value = clonePlainValue(exit.value);
      const post = yield* decide(request, "post", { intent: request.intent, effect: request.effect, result: value });
      return yield* settlePost(request, post, value);
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
  });
}

function policyPoint(request: ExecutionRequest, phase: "pre" | "post"): Pick<PolicyEvaluationInput, "kind" | "phase" | "op"> {
  return request.kind === "compaction"
    ? { kind: "turn", phase: "post", op: request.op === "compact" ? "compaction" : request.op }
    : { kind: request.kind, phase, op: request.op };
}
function needsApproval(stage: { readonly pre: Pick<PolicyEvaluation, "verdict">; readonly request: ExecutionRequest }) {
  return stage.pre.verdict === "require_approval" || stage.request.approval?.required === true;
}
/** The single pre-decision an original intent was admitted under, by id when recorded, else by input hash. */
function recordedDecision(actions: readonly LedgerAction.Node[], original: LedgerAction.Node, decisionId: PlainValue | undefined, inputHash: string) {
  const candidates = actions.filter((action) => action.kind === "policy.decision" && action.ordinal < original.ordinal &&
    (decisionId === undefined ? object(action.intent.value).inputHash === inputHash : action.id === decisionId));
  return candidates.length === 1 ? candidates[0] : undefined;
}
function recordedVerdict(verdict: string): PolicyEvaluation["verdict"] {
  switch (verdict) {
    case "allow": case "deny": case "require_approval": case "transform": case "obligation": return verdict;
    default: throw new ExecutionApprovalError({ code: "stale_approval" });
  }
}
function assertFresh(request: ExecutionRequest, captured: ReturnType<typeof findSessionRequest>): void {
  if (captured !== undefined && request.domainRevisions !== undefined &&
      canonicalDigest({ ...request.domainRevisions() }) !== canonicalDigest(captured.domainRevisions))
    throw new ExecutionApprovalError({ code: "stale_approval" });
}
/** Body results cross the durable boundary as canonical JSON: non-finite numbers become null. */
function clonePlainValue(value: PlainValue): PlainValue {
  return JSON.parse(JSON.stringify(value)) as PlainValue;
}

export function immutableInput(value: PlainValue): PlainValue {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutableInput(child);
    Object.freeze(value);
  }
  return value;
}
function settlePost(request: ExecutionRequest, post: PolicyEvaluation, value: PlainValue): Effect.Effect<ExecutionResult, ExecutionError> {
  const transformed = post.verdict === "transform" ? object(post.value).result : value;
  if (post.verdict !== "deny" && post.verdict !== "require_approval" && transformed !== undefined)
    return Effect.succeed({ terminal: "executed", value: transformed });
  const outcome = { terminal: "blocked_post", disposition: request.revert === undefined ? "irreversible" : "reverted",
    reason: transformed === undefined ? "invalid_output" : post.reason ?? "denied" } as const;
  return request.revert === undefined ? Effect.succeed(outcome) : Effect.as(Effect.suspend(request.revert), outcome);
}
function object(value: PlainValue): PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function terminalStatus(outcome: ExecutionResult): ToolObservationStatus {
  if (outcome.terminal !== "executed" || outcome.failure !== undefined) return "error";
  const status = object(outcome.value).status;
  return status === "success" || status === "timed_out" ? status : "error";
}

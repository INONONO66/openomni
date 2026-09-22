import { Retry } from "@openomni/llm";
import { canonicalDigest, type LedgerAction, type PlainValue } from "@openomni/protocol";
import type { PolicyEvaluation } from "@openomni/policy";
import { Cause, Effect, Exit, Option } from "effect";
import type { AttemptRequest, ExecutorOptions, LlmAttempts } from "./executor-contract";
import { createRetryAlarmPort } from "./executor-retry-alarm";
import type { createExecutionRecord } from "./executor-record";
import { PolicyDenied, type ExecutionError } from "./errors";
import { causeEvidence } from "./executor-outcome";
import { attachFailureFacts } from "./core/retry";

type RecordPort = ReturnType<typeof createExecutionRecord>;
type Admission = PolicyEvaluation & { readonly receipt: LedgerAction.Receipt };
type Prepared<T extends PlainValue> = Effect.Effect.Success<ReturnType<LlmAttempts<T>["prepare"]>>;

function terminalFailure(failure: ExecutionError, attempt: number) {
  if (failure._tag === "LlmRunFailure") attachFailureFacts(failure, {
    reason: failure.aborted ? "aborted" : Retry.attemptReason(failure), attempt, maxAttempts: Retry.MAX_ATTEMPTS, llm: true,
  });
  return Effect.fail(failure);
}
function retryableFailure(cause: Cause.Cause<ExecutionError>) {
  const error = Cause.failureOption(cause);
  return Cause.isInterrupted(cause) || Cause.isDie(cause) || Option.isNone(error)
    ? Effect.failCause(cause) : Effect.succeed(error.value);
}

/** No replay after a visible delta or an abort: the attempt is terminal. */
function failureRequiresStop(failure: ExecutionError, signal: AbortSignal | undefined): boolean {
  if (failure._tag === "CommitFailed" || signal?.aborted === true) return true;
  return failure._tag === "LlmRunFailure" && (failure.aborted || failure.visibleOutput);
}
function retryDelay(recover: boolean, decision: ReturnType<typeof Retry.decide>): number {
  return !recover && decision.retry ? decision.delayMs : 0;
}

export function createAttemptRunner(
  options: ExecutorOptions,
  record: Pick<RecordPort, "appendIntent" | "appendResult" | "appendFailure">,
  admit: (request: AttemptRequest, parent: LedgerAction.Receipt) => Effect.Effect<Admission, ExecutionError>,
  approve: (request: AttemptRequest, intent: LedgerAction.Receipt, admission: Admission) => Effect.Effect<"approve" | "refuse" | "timeout", ExecutionError>,
) {
  const retryAlarm = options.retryAlarm ?? createRetryAlarmPort(options.identity.sessionId, options.clock);
  function approveAttempt(request: AttemptRequest, intent: LedgerAction.Receipt, policy: Admission | undefined) {
    if (policy?.verdict !== "require_approval") return Effect.void;
    return Effect.gen(function* () {
      const decision = yield* approve(request, intent, policy);
      if (decision === "approve") return;
      yield* record.appendResult({ kind: "attempt", op: request.op }, intent.action.id, {
        phase: "result", terminal: "blocked_pre", reason: decision === "timeout" ? "approval_timeout" : "approval_refused",
      });
      return yield* new PolicyDenied({ phase: "pre", ruleIds: policy.matchedRuleIds });
    });
  }
  function admitAttempt<T extends PlainValue>(parent: LedgerAction.Receipt, attempts: LlmAttempts<T>, attempt: number, failures: readonly string[]): Effect.Effect<{ prepared: Prepared<T>; intent: LedgerAction.Receipt }, ExecutionError> {
    return attempts.prepare(attempt, failures).pipe(Effect.flatMap((prepared) => {
      const policyEffect: Effect.Effect<Admission | undefined, ExecutionError> = attempt === 1
        ? Effect.succeed<Admission | undefined>(undefined)
        : admit(prepared.request, parent);
      return policyEffect.pipe(Effect.flatMap((policy) => {
        if (policy !== undefined && (policy.verdict === "deny" || policy.verdict === "transform"))
          return Effect.fail(new PolicyDenied({ phase: "pre", ruleIds: policy.matchedRuleIds }));
        return prepared.admit().pipe(
          Effect.flatMap((): Effect.Effect<void, ExecutionError> => options.signal?.aborted ? Effect.interrupt : Effect.void),
          Effect.flatMap(() => record.appendIntent({
            kind: "attempt", op: prepared.request.op, parentId: parent.action.id, value: prepared.request.intent,
            invocation: { effectHash: canonicalDigest(prepared.request.effect), attempt, maxAttempts: Retry.MAX_ATTEMPTS, retryReason: failures.at(-1) ?? null },
          })),
          Effect.flatMap((intent) => approveAttempt(prepared.request, intent, policy).pipe(
            Effect.as({ prepared, intent }),
          )),
        );
      }));
    }));
  }
  function executeAttempt<T extends PlainValue>(prepared: Prepared<T>, attempts: LlmAttempts<T>, intent: LedgerAction.Receipt) {
    return Effect.uninterruptibleMask((restore) =>
      Effect.exit(restore(prepared.body())).pipe(
        Effect.flatMap((exit) => record.appendResult({ kind: "attempt", op: prepared.request.op }, intent.action.id, {
          phase: "result", effect: prepared.request.effect,
          terminal: Exit.isFailure(exit) && Cause.isInterrupted(exit.cause) ? "interrupted" : "executed",
          evidence: Exit.isSuccess(exit) ? attempts.evidence?.(exit.value) ?? null : causeEvidence(exit.cause),
        }).pipe(Effect.as(exit))),
      ),
    );
  }
  function scheduleRetry<T extends PlainValue>(attempts: LlmAttempts<T>, failure: ExecutionError, attempt: number, instantFailures: number, prepared: Prepared<T>, intent: LedgerAction.Receipt) {
    return Effect.gen(function* () {
      if (failureRequiresStop(failure, options.signal)) return yield* terminalFailure(failure, attempt);
      const overflow = Retry.isContextOverflow(failure);
      const decision = Retry.decide(attempt, failure, instantFailures, prepared.fallbackAvailable);
      if (attempt >= Retry.MAX_ATTEMPTS) return yield* terminalFailure(failure, attempt);
      const recover = overflow && (yield* attempts.recoverOverflow?.(failure) ?? Effect.succeed(false));
      if (!recover && (overflow || !decision.retry)) return yield* terminalFailure(failure, attempt);
      const delayMs = retryDelay(recover, decision);
      const reason = recover ? "context_overflow" : Retry.attemptReason(failure);
      attempts.onRetry?.({ attempt, maxAttempts: Retry.MAX_ATTEMPTS, delayMs, decision, error: failure, reason });
      const id = `${intent.action.id}:retry:${attempt}`;
      const fireAt = options.clock() + delayMs;
      yield* retryAlarm.arm({ id, attempt, reason, fireAt });
      yield* retryAlarm.wait(fireAt, options.signal);
      yield* retryAlarm.settle(id);
      return reason;
    });
  }
  return function runAttempts<T extends PlainValue>(parent: LedgerAction.Receipt, attempts: LlmAttempts<T>): Effect.Effect<T, ExecutionError> {
    return Effect.gen(function* () {
      const failures: string[] = [];
      let instantFailures = 0;
      for (let attempt = 1; ; attempt += 1) {
        if (options.signal?.aborted) return yield* Effect.interrupt;
        const { prepared, intent } = yield* admitAttempt(parent, attempts, attempt, failures);
        const started = options.clock();
        const outcome = yield* executeAttempt(prepared, attempts, intent);
        if (Exit.isSuccess(outcome)) return outcome.value;
        const failure = yield* retryableFailure(outcome.cause);
        instantFailures = Retry.isInstantTransportFailure(failure, options.clock() - started) ? instantFailures + 1 : 0;
        failures.push(yield* scheduleRetry(attempts, failure, attempt, instantFailures, prepared, intent));
      }
    });
  };
}

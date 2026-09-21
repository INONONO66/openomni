import { Retry } from "@openomni/llm";
import { canonicalDigest, type LedgerAction, type PlainValue } from "@openomni/protocol";
import type { PolicyEvaluation } from "@openomni/policy";
import { Cause, Effect, Exit, Option } from "effect";
import type { AttemptRequest, ExecutorOptions, LlmAttempts } from "./executor-contract";
import { createRetryAlarmPort } from "./executor-retry-alarm";
import type { createExecutionRecord } from "./executor-record";
import { PolicyDenied, type ExecutionError } from "./errors";
import { causeEvidence } from "./executor-outcome";

type RecordPort = ReturnType<typeof createExecutionRecord>;
type Admission = PolicyEvaluation & { readonly receipt: LedgerAction.Receipt };

export function createAttemptRunner(
  options: ExecutorOptions,
  record: Pick<RecordPort, "appendIntent" | "appendResult" | "appendFailure">,
  admit: (request: AttemptRequest, parent: LedgerAction.Receipt) => Effect.Effect<Admission, ExecutionError>,
  approve: (request: AttemptRequest, intent: LedgerAction.Receipt, admission: Admission) =>
    Effect.Effect<"approve" | "refuse" | "timeout", ExecutionError>,
) {
  const retryAlarm = options.retryAlarm ?? createRetryAlarmPort(options.identity.sessionId, options.clock);

  function admitAttempt<T extends PlainValue>(parent: LedgerAction.Receipt,
    attempts: LlmAttempts<T>, attempt: number, failures: readonly string[]) {
    return Effect.gen(function* () {
      const prepared = yield* attempts.prepare(attempt, failures);
      const policy = attempt === 1 ? undefined : yield* admit(prepared.request, parent);
      if (policy !== undefined && (policy.verdict === "deny" || policy.verdict === "transform"))
        return yield* new PolicyDenied({ phase: "pre", ruleIds: policy.matchedRuleIds });
      yield* prepared.admit();
      if (options.signal?.aborted) return yield* Effect.interrupt;
      const intent = yield* record.appendIntent({
        kind: "attempt", op: prepared.request.op, parentId: parent.action.id, value: prepared.request.intent,
        invocation: { effectHash: canonicalDigest(prepared.request.effect), attempt,
          maxAttempts: Retry.MAX_ATTEMPTS, retryReason: failures.at(-1) ?? null },
      });
      if (policy?.verdict === "require_approval") {
        const decision = yield* approve(prepared.request, intent, policy);
        if (decision !== "approve") {
          yield* record.appendResult({ kind: "attempt", op: prepared.request.op }, intent.action.id, {
            phase: "result", terminal: "blocked_pre",
            reason: decision === "timeout" ? "approval_timeout" : "approval_refused",
          });
          return yield* new PolicyDenied({ phase: "pre", ruleIds: policy.matchedRuleIds });
        }
      }
      return { prepared, intent };
    });
  }

  return function runAttempts<T extends PlainValue>(parent: LedgerAction.Receipt,
    attempts: LlmAttempts<T>): Effect.Effect<T, ExecutionError> {
    return Effect.gen(function* () {
      const failures: string[] = [];
      let instantFailures = 0;
      for (let attempt = 1; ; attempt += 1) {
        if (options.signal?.aborted) return yield* Effect.interrupt;
        const { prepared, intent } = yield* admitAttempt(parent, attempts, attempt, failures);
        const started = options.clock();
        const outcome = yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
          const exit = yield* Effect.exit(restore(Effect.scoped(prepared.body())));
          yield* record.appendResult({ kind: "attempt", op: prepared.request.op }, intent.action.id, {
            phase: "result", effect: prepared.request.effect,
            terminal: Exit.isFailure(exit) && Cause.isInterrupted(exit.cause) ? "interrupted" : "executed",
            ...(Exit.isSuccess(exit) ? { evidence: attempts.evidence?.(exit.value) ?? null }
              : { evidence: causeEvidence(exit.cause) }),
          });
          return exit;
        }));
        if (Exit.isSuccess(outcome)) return outcome.value;
        const error = Cause.failureOption(outcome.cause);
        if (Cause.isInterrupted(outcome.cause) || Cause.isDie(outcome.cause) || Option.isNone(error))
          return yield* Effect.failCause(outcome.cause);
        const failure = error.value;
        if (failure._tag === "CommitFailed" || options.signal?.aborted) return yield* failure;
        const overflow = Retry.isContextOverflow(failure);
        instantFailures = Retry.isInstantTransportFailure(failure, options.clock() - started) ? instantFailures + 1 : 0;
        const decision = Retry.decide(attempt, failure, instantFailures, prepared.fallbackAvailable);
        if (attempt >= Retry.MAX_ATTEMPTS) return yield* failure;
        const recover = overflow && (yield* attempts.recoverOverflow?.(failure) ?? Effect.succeed(false));
        if (!recover && (overflow || !decision.retry)) return yield* failure;
        const delayMs = recover ? 0 : decision.retry ? decision.delayMs : 0;
        const reason = recover ? "context_overflow" : Retry.attemptReason(failure);
        failures.push(reason);
        attempts.onRetry?.({ attempt, maxAttempts: Retry.MAX_ATTEMPTS, delayMs, decision, error: failure, reason });
        const id = `${intent.action.id}:retry:${attempt}`;
        const fireAt = options.clock() + delayMs;
        yield* retryAlarm.arm({ id, attempt, reason, fireAt });
        yield* retryAlarm.wait(fireAt, options.signal);
        yield* retryAlarm.settle(id);
      }
    });
  };
}

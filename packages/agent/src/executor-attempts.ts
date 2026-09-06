import { Retry, Run } from "@openomni/llm";
import type { LedgerAction, PlainValue } from "@openomni/protocol";
import type { PolicyEvaluation } from "@openomni/policy";
import type { AttemptRequest, ExecutorOptions, LlmAttempts } from "./executor-contract";
import type { createExecutionRecord } from "./executor-record";

type RecordPort = ReturnType<typeof createExecutionRecord>;
type Admission = PolicyEvaluation & { readonly receipt: LedgerAction.Receipt };

/** The executor alone schedules attempts; llm supplies failure classification and delay. */
export function createAttemptRunner(
  options: ExecutorOptions,
  record: Pick<RecordPort, "appendIntent" | "appendResult" | "appendFailure">,
  admit: (request: AttemptRequest, parent: LedgerAction.Receipt) => Promise<Admission>,
  approve: (
    request: AttemptRequest,
    intent: LedgerAction.Receipt,
    admission: Admission,
  ) => Promise<"approve" | "refuse" | "timeout">,
) {
  return async function runAttempts<T extends PlainValue>(
    parent: LedgerAction.Receipt,
    attempts: LlmAttempts<T>,
  ): Promise<T> {
    const failures: string[] = [];
    let instantFailures = 0;
    for (let attempt = 1; ; attempt += 1) {
      options.signal?.throwIfAborted();
      // Preparation is not a provider attempt: invalid identity/config never earns a retry.
      const prepared = await attempts.prepare(attempt, failures);
      const policy = attempt === 1 ? undefined : await admit(prepared.request, parent);
      if (policy !== undefined && (policy.verdict === "deny" || policy.verdict === "transform"))
        throw new Error(`llm admission refused: ${policy.reason ?? policy.verdict}`);
      await prepared.admit();
      options.signal?.throwIfAborted();
      const intent = await record.appendIntent({
        kind: "attempt",
        op: prepared.request.op,
        parentId: parent.action.id,
        value: prepared.request.intent,
      });
      if (policy?.verdict === "require_approval") {
        const decision = await approve(prepared.request, intent, policy);
        if (decision !== "approve") {
          await record.appendResult(
            { kind: "attempt", op: prepared.request.op },
            intent.action.id,
            {
              phase: "result",
              terminal: "blocked_pre",
              reason: decision === "timeout" ? "approval_timeout" : "approval_refused",
            },
          );
          throw new Error(`llm attempt approval ${decision}`);
        }
      }
      const started = options.clock();
      const outcome = await prepared.body().then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: Error) => ({
          status: "rejected" as const,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      );
      if (outcome.status === "fulfilled") {
        await record.appendResult({ kind: "attempt", op: prepared.request.op }, intent.action.id, {
          phase: "result",
          terminal: "executed",
          effect: prepared.request.effect,
        });
        return outcome.value;
      }
      await record.appendFailure(
        { kind: "attempt", op: prepared.request.op },
        intent.action.id,
        prepared.request.effect,
        outcome.error,
      );
      const failure = outcome.error instanceof Run.FailureError ? outcome.error : undefined;
      if (options.signal?.aborted || failure?.data.aborted || failure?.data.visibleOutput)
        throw outcome.error;
      const overflow = Retry.isContextOverflow(outcome.error);
      instantFailures = Retry.isInstantTransportFailure(outcome.error, options.clock() - started)
        ? instantFailures + 1
        : 0;
      const decision = Retry.decide(
        attempt,
        outcome.error,
        instantFailures,
        prepared.fallbackAvailable,
      );
      if (attempt >= Retry.MAX_ATTEMPTS) throw outcome.error;
      const recover = overflow && (await attempts.recoverOverflow?.(outcome.error)) === true;
      if (!recover && (overflow || !decision.retry)) throw outcome.error;
      const delayMs = recover ? 0 : decision.retry ? decision.delayMs : 0;
      failures.push(recover ? "context_overflow" : Retry.attemptReason(outcome.error));
      attempts.onRetry?.({
        attempt,
        maxAttempts: Retry.MAX_ATTEMPTS,
        delayMs,
        decision,
        error: outcome.error,
        reason: failures[failures.length - 1] ?? "transient_error",
      });
      await (options.waitRetry ?? Retry.sleep)(delayMs, options.signal);
    }
  };
}

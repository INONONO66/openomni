import { Retry, Run } from "@openomni/llm";
import { canonicalDigest, type LedgerAction, type PlainValue } from "@openomni/protocol";
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
  // Attempt ordinal, the provider-retry cap and the reason this attempt
  // exists are pinned on the intent; llm decided them, the ledger keeps them.
  function appendAttemptIntent(
    request: AttemptRequest,
    parent: LedgerAction.Receipt,
    attempt: number,
    failures: readonly string[],
  ): Promise<LedgerAction.Receipt> {
    return record.appendIntent({
      kind: "attempt",
      op: request.op,
      parentId: parent.action.id,
      value: request.intent,
      invocation: {
        effectHash: canonicalDigest(request.effect),
        attempt,
        maxAttempts: Retry.MAX_ATTEMPTS,
        retryReason: failures.at(-1) ?? null,
      },
    });
  }
  function appendExecuted(
    request: AttemptRequest,
    intent: LedgerAction.Receipt,
    evidence: PlainValue | undefined,
  ): Promise<void> {
    return record.appendResult({ kind: "attempt", op: request.op }, intent.action.id, {
      phase: "result",
      terminal: "executed",
      effect: request.effect,
      ...(evidence === undefined ? {} : { evidence }),
    });
  }
  async function waitForRetry<T extends PlainValue>(
    attempts: LlmAttempts<T>,
    retry: {
      readonly attempt: number;
      readonly delayMs: number;
      readonly decision: Retry.Decision;
      readonly error: Error;
      readonly reason: string;
    },
  ): Promise<void> {
    attempts.onRetry?.({ ...retry, maxAttempts: Retry.MAX_ATTEMPTS });
    await (options.waitRetry ?? Retry.sleep)(retry.delayMs, options.signal);
  }
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
      const intent = await appendAttemptIntent(prepared.request, parent, attempt, failures);
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
        await appendExecuted(prepared.request, intent, attempts.evidence?.(outcome.value));
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
      const reason = recover ? "context_overflow" : Retry.attemptReason(outcome.error);
      failures.push(reason);
      await waitForRetry(attempts, { attempt, delayMs, decision, error: outcome.error, reason });
    }
  };
}

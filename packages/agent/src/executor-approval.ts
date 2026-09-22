import {
  canonicalDigest,
  PlainValueSchema,
  type SessionTransition,
  type PlainValue,
} from "@openomni/protocol";
import { Deferred, Effect, Exit } from "effect";
import type {
  ExecutionApprovals,
  ExecutionApprovalRequest,
  ExecutorOptions,
} from "./executor-contract";
import { ExecutionApprovalError, type ExecutionError } from "./errors";
import { createApprovalRequest, findSessionRequest } from "./session-request";

type ApprovalDecision = "approve" | "refuse" | "timeout";

export function createExecutionApprovals(options: ExecutorOptions) {
  if (options.approvalTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.approvalTimeoutMs) || options.approvalTimeoutMs < 0))
    throw new TypeError("approval timeout must be a nonnegative integer");
  const pending = new Map<string, {
    request: ExecutionApprovalRequest;
    signal: AbortSignal;
    decision: Deferred.Deferred<ApprovalDecision>;
    revisions?: () => Readonly<Record<string, number>>;
  }>();
  function transition(payload: SessionTransition.Payload, inputId: string) {
    return options.ledger.transition === undefined
      ? Effect.fail(new ExecutionApprovalError({ code: "approval_authority_unavailable" }))
      : options.ledger.transition(payload, inputId, options.clock());
  }
  function notify(request: SessionTransition.Request) {
    const persisted = findSessionRequest(options.ledger.actions?.() ?? [], request.requestId);
    const suspended = pending.get(request.requestId);
    if (suspended === undefined || persisted === undefined || persisted.state === "open") return;
    const value = persisted.state === "resolved" ? "approve"
      : persisted.state === "expired" ? "timeout" : "refuse";
    Deferred.unsafeDone(suspended.decision, Exit.succeed(value));
  }
  const approvals: ExecutionApprovals = {
    pending: () => [...pending.values()].map((value) => structuredClone(value.request)),
    notify,
    answer: (answer) => Effect.gen(function* () {
      const suspended = pending.get(answer.request.id);
      const valid = () =>
        suspended !== undefined &&
        !suspended.signal.aborted &&
        pending.get(answer.request.id) === suspended &&
        canonicalDigest(PlainValueSchema.parse(answer.request)) ===
          canonicalDigest(PlainValueSchema.parse(suspended.request)) &&
        (suspended.revisions === undefined ||
          canonicalDigest({ ...suspended.revisions() }) ===
            canonicalDigest(suspended.request.durable.domainRevisions));
      if (!valid() || suspended === undefined)
        return yield* new ExecutionApprovalError({ code: "stale_approval" });
      if (options.authorizeApproval === undefined)
        return yield* new ExecutionApprovalError({ code: "approval_authority_unavailable" });
      const principal = yield* options.authorizeApproval(answer.credential, suspended.request);
      if (!valid()) return yield* new ExecutionApprovalError({ code: "stale_approval" });
      const request = suspended.request.durable;
      const input: SessionTransition.Answer = {
        inputId: `${request.requestId}:owner-answer`,
        requestId: request.requestId,
        sessionId: request.sessionId,
        receivedAt: options.clock(),
        principal,
        bindingDigest: request.bindingDigest,
        inputHash: request.inputHash,
        effectHash: request.effectHash,
        generation: request.generation,
        toolsHash: request.toolsHash,
        domainRevisions: request.domainRevisions,
        decision: answer.decision,
        allowedAction: "report_result",
        content: answer.decision,
      };
      const result = yield* transition({ kind: "request.answer", answer: input }, input.inputId);
      if (result.request !== undefined) notify(result.request);
      if (result.request === undefined || !["resolved", "refused"].includes(result.resolution))
        return yield* new ExecutionApprovalError({ code: "stale_approval" });
    }),
  };
  function awaitApproval(
    captured: Omit<ExecutionApprovalRequest, "durable">,
    signal: AbortSignal,
    binding: {
      effect: PlainValue;
      domainRevisions?: Readonly<Record<string, number>>;
      revisions?: () => Readonly<Record<string, number>>;
      timeoutMs?: number;
      original?: SessionTransition.Request;
    },
  ): Effect.Effect<ApprovalDecision, ExecutionError> {
    return Effect.gen(function* () {
      const timeout = binding.timeoutMs ?? options.approvalTimeoutMs ?? 86_400_000;
      const durable = binding.original ??
        createApprovalRequest(captured, binding, options.identity.systemHash, options.clock(), timeout);
      const request: ExecutionApprovalRequest = { ...captured, expiresAt: durable.deadline, durable };
      const decision = yield* Deferred.make<ApprovalDecision>();
      pending.set(request.id, { request, signal, decision, revisions: binding.revisions });
      const cancel = transition({
        kind: "request.cancel",
        requestId: request.id,
        principal: { kind: "session", principalId: request.sessionId, evidenceId: request.id },
      }, `${request.id}:cancel`).pipe(Effect.as("refuse" as const));
      const wait = Effect.gen(function* () {
        if (binding.original === undefined) {
          const opened = yield* transition({ kind: "request.open", request: durable }, `${request.id}:open`);
          if (opened.resolution !== "opened")
            return yield* new ExecutionApprovalError({ code: "stale_approval" });
        }
        notify(durable);
        return yield* Deferred.await(decision).pipe(Effect.raceFirst(aborted(signal).pipe(Effect.zipRight(cancel))));
      });
      return yield* wait.pipe(
        Effect.onInterrupt(() => Effect.orDie(cancel)),
        Effect.ensuring(Effect.sync(() => pending.delete(request.id))),
      );
    });
  }
  return { approvals, awaitApproval };
}

function aborted(signal: AbortSignal): Effect.Effect<void> {
  return Effect.async<void>((resume) => {
    const abort = () => resume(Effect.void);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
}

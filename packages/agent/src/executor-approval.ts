import {
  canonicalDigest,
  PlainValueSchema,
  type SessionTransition,
  type PlainValue,
} from "@openomni/protocol";
import {
  ExecutionApprovalError,
  type ExecutionApprovals,
  type ExecutionApprovalRequest,
  type ExecutorOptions,
} from "./executor-contract";
import { createApprovalRequest, findSessionRequest } from "./session-request";

type ApprovalDecision = "approve" | "refuse" | "timeout";

/** A live promise over durable request facts; it owns no independent approval state. */
export function createExecutionApprovals(options: ExecutorOptions) {
  if (
    options.approvalTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.approvalTimeoutMs) || options.approvalTimeoutMs < 0)
  )
    throw new TypeError("approval timeout must be a nonnegative integer");
  const pending = new Map<
    string,
    {
      request: ExecutionApprovalRequest;
      signal: AbortSignal;
      settle: (decision: ApprovalDecision) => void;
      revisions?: () => Readonly<Record<string, number>>;
    }
  >();
  const transition = (payload: SessionTransition.Payload, inputId: string) => {
    if (options.ledger.transition === undefined)
      throw new ExecutionApprovalError("approval_authority_unavailable");
    return options.ledger.transition(payload, inputId, options.clock());
  };
  const notify = (request: SessionTransition.Request) => {
    const persisted = findSessionRequest(options.ledger.actions?.() ?? [], request.requestId);
    const suspended = pending.get(request.requestId);
    if (suspended === undefined || persisted === undefined || persisted.state === "open") return;
    pending.delete(request.requestId);
    suspended.settle(
      persisted.state === "resolved"
        ? "approve"
        : persisted.state === "expired"
          ? "timeout"
          : "refuse",
    );
  };
  const approvals: ExecutionApprovals = {
    pending: () => [...pending.values()].map((value) => structuredClone(value.request)),
    notify,
    async answer(answer) {
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
      if (!valid() || suspended === undefined) throw new ExecutionApprovalError("stale_approval");
      if (options.authorizeApproval === undefined)
        throw new ExecutionApprovalError("approval_authority_unavailable");
      const principal = await options.authorizeApproval(answer.credential, suspended.request);
      if (!valid()) throw new ExecutionApprovalError("stale_approval");
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
      const decision = await transition({ kind: "request.answer", answer: input }, input.inputId);
      if (decision.request !== undefined) notify(decision.request);
      if (decision.request === undefined || !["resolved", "refused"].includes(decision.resolution))
        throw new ExecutionApprovalError("stale_approval");
    },
  };
  async function awaitApproval(
    captured: Omit<ExecutionApprovalRequest, "durable">,
    signal: AbortSignal,
    binding: {
      effect: PlainValue;
      domainRevisions?: Readonly<Record<string, number>>;
      revisions?: () => Readonly<Record<string, number>>;
      timeoutMs?: number;
      original?: SessionTransition.Request;
    },
  ): Promise<ApprovalDecision> {
    const timeout = binding.timeoutMs ?? options.approvalTimeoutMs ?? 86_400_000;
    const createdAt = options.clock();
    const durable =
      binding.original ??
      createApprovalRequest(captured, binding, options.identity.systemHash, createdAt, timeout);
    const request: ExecutionApprovalRequest = { ...captured, expiresAt: durable.deadline, durable };
    const decision = Promise.withResolvers<ApprovalDecision>();
    pending.set(request.id, {
      request,
      signal,
      settle: decision.resolve,
      revisions: binding.revisions,
    });
    const abort = () => {
      void transition(
        {
          kind: "request.cancel",
          requestId: request.id,
          principal: { kind: "session", principalId: request.sessionId, evidenceId: request.id },
        },
        `${request.id}:cancel`,
      ).then((result) => {
        if (result.request !== undefined) notify(result.request);
        else decision.resolve("refuse");
      }, decision.reject);
    };
    try {
      if (binding.original === undefined) {
        const opened = await transition(
          { kind: "request.open", request: durable },
          `${request.id}:open`,
        );
        if (opened.resolution !== "opened") throw new ExecutionApprovalError("stale_approval");
      }
      // The durable at-alarm is the sole deadline owner, including recovery.
      // Re-read after admission in case an answer committed while opening.
      notify(durable);
      if (pending.has(request.id)) {
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
      return await decision.promise;
    } finally {
      signal.removeEventListener("abort", abort);
      pending.delete(request.id);
    }
  }
  return { approvals, awaitApproval };
}

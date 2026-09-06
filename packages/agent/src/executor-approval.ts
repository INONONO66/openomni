import { canonicalDigest, Deadline, PlainValueSchema, type LedgerAction } from "@openomni/protocol";
import {
  ExecutionApprovalError,
  type ExecutionApprovals,
  type ExecutionApprovalRequest,
  type ExecutorOptions,
} from "./executor-contract";

type ApprovalDecision = "approve" | "refuse" | "timeout";

/** Per-executor suspension capability. All durable authority remains with its supplied executor commit. */
export function createExecutionApprovals(
  options: ExecutorOptions,
  commit: (action: LedgerAction.Append) => Promise<LedgerAction.Receipt>,
) {
  if (
    options.approvalTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.approvalTimeoutMs) || options.approvalTimeoutMs < 0)
  ) {
    throw new TypeError("approval timeout must be a nonnegative integer");
  }
  const expired = (request: ExecutionApprovalRequest) =>
    request.expiresAt !== undefined && Deadline.isExpired(options.clock(), request.expiresAt);
  const pendingApprovals = new Map<
    string,
    {
      readonly request: ExecutionApprovalRequest;
      readonly signal: AbortSignal;
      readonly resolve: (decision: ApprovalDecision) => void;
      answering: boolean;
    }
  >();
  const approvals: ExecutionApprovals = {
    pending: () => [...pendingApprovals.values()].map((value) => structuredClone(value.request)),
    async answer(answer) {
      const pending = pendingApprovals.get(answer.request.id);
      if (
        pending === undefined ||
        pending.answering ||
        pending.signal.aborted ||
        expired(pending.request) ||
        canonicalDigest(PlainValueSchema.parse(pending.request)) !==
          canonicalDigest(PlainValueSchema.parse(answer.request))
      ) {
        throw new ExecutionApprovalError("stale_approval");
      }
      if (options.authorizeApproval === undefined)
        throw new ExecutionApprovalError("approval_authority_unavailable");
      const evidence = await options.authorizeApproval(answer.credential, pending.request);
      if (
        pending.answering ||
        pending.signal.aborted ||
        expired(pending.request) ||
        pendingApprovals.get(answer.request.id) !== pending
      ) {
        throw new ExecutionApprovalError("stale_approval");
      }
      pending.answering = true;
      await commit({
        id: options.entropy(),
        parentId: pending.request.id,
        sessionId: options.identity.sessionId,
        kind: "policy.decision",
        intent: { encodingVersion: 1, value: { phase: "approval", op: "answer" } },
        effect: {
          encodingVersion: 1,
          value: PlainValueSchema.parse({
            decision: answer.decision,
            evidence,
            request: pending.request,
          }),
        },
        ts: options.clock(),
        irreversible: true,
      });
      pendingApprovals.delete(answer.request.id);
      pending.resolve(answer.decision);
    },
  };

  async function awaitApproval(
    requested: ExecutionApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    const request =
      options.approvalTimeoutMs === undefined
        ? requested
        : { ...requested, expiresAt: options.clock() + options.approvalTimeoutMs };
    const decision = Promise.withResolvers<ApprovalDecision>();
    let cancelDeadline: (() => void) | undefined;
    const abort = () => decision.resolve("refuse");
    pendingApprovals.set(request.id, {
      request,
      signal,
      resolve: decision.resolve,
      answering: false,
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      await commit({
        id: options.entropy(),
        parentId: request.id,
        sessionId: options.identity.sessionId,
        kind: "policy.decision",
        intent: { encodingVersion: 1, value: { phase: "approval", op: "request" } },
        effect: {
          encodingVersion: 1,
          value: PlainValueSchema.parse({ state: "pending", request }),
        },
        ts: options.clock(),
        irreversible: true,
      });
      if (options.approvalTimeoutMs !== undefined) {
        const expire = async () => {
          const pending = pendingApprovals.get(request.id);
          if (pending === undefined || pending.answering || signal.aborted || !expired(request))
            return;
          pending.answering = true;
          await commit({
            id: options.entropy(),
            parentId: request.id,
            sessionId: options.identity.sessionId,
            kind: "policy.decision",
            intent: { encodingVersion: 1, value: { phase: "approval", op: "timeout" } },
            effect: {
              encodingVersion: 1,
              value: PlainValueSchema.parse({
                decision: "timeout",
                request,
                evidence: { kind: "deadline", at: options.clock(), expiresAt: request.expiresAt },
              }),
            },
            ts: options.clock(),
            irreversible: true,
          });
          pendingApprovals.delete(request.id);
          decision.resolve("timeout");
        };
        const callback = () => {
          void expire().catch(decision.reject);
        };
        if (options.scheduleApprovalTimeout !== undefined)
          cancelDeadline = options.scheduleApprovalTimeout(callback, options.approvalTimeoutMs);
        else {
          const timer = setTimeout(callback, options.approvalTimeoutMs);
          cancelDeadline = () => clearTimeout(timer);
        }
      }
      if (signal.aborted) abort();
      return await decision.promise;
    } finally {
      cancelDeadline?.();
      signal.removeEventListener("abort", abort);
      pendingApprovals.delete(request.id);
    }
  }

  return { approvals, awaitApproval };
}

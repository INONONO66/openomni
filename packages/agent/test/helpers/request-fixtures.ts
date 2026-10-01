import { canonicalDigest, type LedgerAction, type SessionTransition } from "@openomni/protocol";

/** One pending irreversible "write original" tool invocation node. */
export function invocationNode(input: {
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly domainRevisions?: Record<string, number>;
}): LedgerAction.Node {
  return {
    id: "invocation",
    sessionId: input.sessionId,
    parentId: input.parentId,
    kind: "tool",
    ts: 1,
    ordinal: 1,
    prevHash: "fixture-prev",
    actionHash: "fixture-hash",
    intent: {
      encodingVersion: 1,
      value: {
        phase: "intent",
        op: "write",
        value: { path: "original" },
        effectHash: canonicalDigest({ category: "mutation" }),
        ...(input.domainRevisions === undefined ? {} : { domainRevisions: input.domainRevisions }),
      },
    },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    irreversible: true,
  };
}

/** An owner's approve answer bound to the pending request. */
export function approvalAnswer(
  pending: SessionTransition.Request,
  inputId: string,
  receivedAt: number,
): SessionTransition.Answer {
  return {
    inputId,
    requestId: pending.requestId,
    sessionId: pending.sessionId,
    receivedAt,
    principal: { kind: "owner", principalId: "owner", evidenceId: "authenticated" },
    bindingDigest: pending.bindingDigest,
    inputHash: pending.inputHash,
    effectHash: pending.effectHash,
    generation: pending.generation,
    toolsHash: pending.toolsHash,
    domainRevisions: pending.domainRevisions,
    decision: "approve",
    allowedAction: "report_result",
    content: "yes",
  };
}

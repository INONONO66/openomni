import { SessionHandleStore } from "@openomni/ledger";
import { canonicalDigest } from "@openomni/protocol";
import type { createGatewayRouter } from "@openomni/channels";

type Request = Parameters<Parameters<typeof createGatewayRouter>[0]["run"]>[1];

export function messageDecisionRules(sessionId: string, request: Request): readonly string[] {
  const inputHash = canonicalDigest({
    kind: "message",
    phase: "pre",
    op: request.op,
    role: SessionHandleStore.row(sessionId).role,
    sessionId,
    message: request.message,
    value: request.intent,
  });
  const ids = SessionHandleStore.policyDecisionRuleIds(sessionId, inputHash);
  if (ids === undefined) throw new Error("message pre decision is missing");
  return ids;
}

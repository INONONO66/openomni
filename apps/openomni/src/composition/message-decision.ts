import { canonicalDigest } from "@openomni/protocol";
import type { createGatewayRouter } from "@openomni/channels";
import type { SessionKernel } from "./cluster-runtime";

type Request = Parameters<Parameters<typeof createGatewayRouter>[0]["run"]>[1];

export function messageDecisionRules(
  kernel: SessionKernel,
  sessionId: string,
  request: Request,
): readonly string[] {
  const inputHash = canonicalDigest({
    kind: "message",
    phase: "pre",
    op: request.op,
    role: kernel.row(sessionId).role,
    sessionId,
    message: request.message,
    value: request.intent,
  });
  const ids = kernel.policyDecisionRuleIds(sessionId, inputHash);
  if (ids === undefined) throw new Error("message pre decision is missing");
  return ids;
}

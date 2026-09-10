import { type PlainValue, SessionTransition } from "@openomni/protocol";

export function approvalRequest(
  parsedInput: PlainValue,
  domainRevisions: Record<string, number>,
): SessionTransition.Request {
  return SessionTransition.Request.parse({
    requestId: "request",
    sessionId: "session",
    turnId: null,
    callId: "call",
    mode: "approval",
    parsedInput,
    inputHash: "input",
    effectHash: "effect",
    generation: 1,
    toolsGeneration: 1,
    toolsHash: "tools",
    systemHash: "system",
    domainRevisions,
    deadline: 1000,
    expectedResponders: ["owner"],
    correlation: {},
    allowedActions: ["report_result"],
    bindingDigest: "binding",
    resolution: "first",
    threshold: 1,
    seenReplyIds: [],
    replies: [],
    state: "open",
    outcome: null,
    createdAt: 1,
  });
}

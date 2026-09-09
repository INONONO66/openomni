import { canonicalDigest, type SessionTransition } from "@openomni/protocol";
import { requestBindingDigest } from "../../src/session-request";

type Overrides = Partial<Omit<SessionTransition.Request, "bindingDigest">> &
  Pick<SessionTransition.Request, "requestId" | "sessionId" | "turnId" | "callId">;

/** One open first-responder approval request with its binding digest already sealed. */
export function openRequest(overrides: Overrides): SessionTransition.Request {
  const parsedInput = overrides.parsedInput ?? {};
  const request: SessionTransition.Request = {
    mode: "approval",
    parsedInput,
    inputHash: canonicalDigest(parsedInput),
    effectHash: canonicalDigest({ category: "mutation" }),
    generation: 1,
    toolsGeneration: 1,
    toolsHash: "tools",
    systemHash: "system",
    domainRevisions: {},
    deadline: 100,
    expectedResponders: ["owner"],
    correlation: {},
    allowedActions: ["report_result"],
    resolution: "first",
    threshold: 1,
    seenReplyIds: [],
    replies: [],
    state: "open",
    outcome: null,
    createdAt: 1,
    ...overrides,
    bindingDigest: "",
  };
  request.bindingDigest = requestBindingDigest(request);
  return request;
}

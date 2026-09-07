import { type LedgerAction, type LedgerSession, SessionTransition } from "@openomni/protocol";
import { SessionHandleStore } from "../../src/index";
import { materializeSession } from "./session";

export function requestFixture(mode: SessionTransition.Request["mode"] = "reply") {
  materializeSession("request-session");
  const lease = SessionHandleStore.acquireLease({
    sessionId: "request-session",
    owner: "writer",
    expectedFence: 0,
    now: 2,
    expiresAt: 1002,
  });
  if (!lease.ok) throw new Error("fixture lease refused");
  const request = SessionTransition.Request.parse({
    requestId: "original",
    sessionId: "request-session",
    turnId: null,
    callId: "call",
    mode,
    parsedInput: { destination: "alice", body: "original bytes" },
    inputHash: "input-hash",
    effectHash: "effect-hash",
    generation: 1,
    toolsGeneration: 1,
    toolsHash: "tools-hash",
    systemHash: "system-hash",
    domainRevisions: { person: 3 },
    deadline: 100,
    expectedResponders: ["alice"],
    correlation: { channelId: "channel", replyToMessageId: "external" },
    allowedActions: ["report_result"],
    bindingDigest: "binding",
    resolution: "first",
    threshold: 1,
    seenReplyIds: [],
    replies: [],
    state: "open",
    outcome: null,
    createdAt: 3,
  });
  const original: LedgerAction.Append = {
    id: request.requestId,
    parentId: "request-session:configure",
    sessionId: request.sessionId,
    kind: "tool",
    intent: { encodingVersion: 1, value: { parsedInput: request.parsedInput } },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    irreversible: true,
    ts: 3,
  };
  const commit = (
    actions: LedgerAction.Append[],
    revision = SessionHandleStore.row(request.sessionId).revision,
  ) =>
    SessionHandleStore.commitRequestTransition({
      sessionId: request.sessionId,
      owner: "writer",
      fence: lease.fence,
      now: 4,
      expectedRevision: revision,
      actions,
      consumeInboxIds: [],
      state: "idle",
      releaseLease: false,
    });
  return { request, original, commit, lease };
}

export function requestStateAction(
  request: SessionTransition.Request,
  id = `${request.requestId}:open`,
  kind: LedgerAction.Kind = "request",
): LedgerAction.Append {
  return {
    id,
    parentId: request.requestId,
    sessionId: request.sessionId,
    kind,
    intent: { encodingVersion: 1, value: { requestId: request.requestId } },
    effect: { encodingVersion: 1, value: { phase: "state", request } },
    irreversible: true,
    ts: 4,
  };
}

export function expectCommitted(result: LedgerSession.CommitResult) {
  if (!result.ok) throw new Error(`commit refused: ${result.reason}`);
  return result;
}

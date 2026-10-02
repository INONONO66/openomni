import { Effect, Result } from "effect";
import { type LedgerAction, type LedgerSession, SessionTransition } from "@openomni/protocol";
import type * as SessionHandleStore from "../../../src/store/fence";
import { adoptWriter, materializeSession } from "./session";
import { runLedgerSync } from "./effect";

export function requestFixture(
  kernel: SessionHandleStore.SessionKernel,
  mode: SessionTransition.Request["mode"] = "reply",
) {
  materializeSession(kernel, "request-session");
  const authority = adoptWriter(kernel, "request-session");
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
    revision = kernel.row(request.sessionId).revision,
  ) =>
    Result.getOrThrowWith(
      runLedgerSync(
        Effect.result(
          kernel.commitRequestTransition({
            sessionId: request.sessionId,
            owner: authority.owner,
            fence: authority.fence,
            now: 4,
            expectedRevision: revision,
            actions,
            state: "idle",
          }),
        ),
      ),
      (error) => error,
    );
  return { request, original, commit, authority };
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

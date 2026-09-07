import { SessionTransition, type Gateway, type LedgerAction, type Inbox, type PlainValue } from "@openomni/protocol";
import type { GatewayRouterPorts } from "../message-ports";

export async function answerNativeRequest(
  requests: GatewayRouterPorts["requests"], sender: Gateway.IngestSender,
  origin: PlainValue | undefined, content: string, at: number,
): Promise<boolean> {
  const parsed = SessionTransition.OutboundMessage.safeParse(origin);
  if (!parsed.success) return false;
  const message = parsed.data;
  if (sender.kind !== "session" || sender.id !== message.sourceSessionId || content !== message.content)
    throw new Error("native reply binding mismatch");
  const request = requests.list().find((candidate) => candidate.requestId === message.requestId);
  if (request === undefined || request.sessionId !== message.destinationSessionId)
    throw new Error("native reply original request is missing");
  await requests.answer({
    inputId: message.messageId, requestId: request.requestId, sessionId: request.sessionId,
    receivedAt: at,
    principal: { kind: "session", principalId: sender.id, evidenceId: message.sourceActionId },
    bindingDigest: request.bindingDigest, inputHash: request.inputHash, effectHash: request.effectHash,
    generation: request.generation, toolsHash: request.toolsHash, domainRevisions: request.domainRevisions,
    decision: "reply", allowedAction: "report_result", content, outbound: message,
  });
  return true;
}

export async function openNativeRequest(
  requests: GatewayRouterPorts["requests"], intent: LedgerAction.Receipt,
  sender: Gateway.IngestSender, send: Gateway.SendMessage, target: string, at: number, admission?: Inbox.Commit,
): Promise<void> {
  if (sender.kind !== "session" || send.type !== "message" || (send.deadline === undefined && send.to.kind !== "new_session")) return;
  await requests.open({
    requestId: intent.action.id, sessionId: sender.id, expectedResponders: [target],
    correlation: {}, allowedActions: ["report_result"], resolution: "first", threshold: 1,
    deadline: send.deadline ?? Number.MAX_SAFE_INTEGER, at,
    ...(admission?.createSession === undefined ? {} : { admission }),
  });
}

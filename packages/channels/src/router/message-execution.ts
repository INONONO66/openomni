import { SurfaceKey } from "@openomni/ledger";
import {
  Inbox,
  canonicalDigest,
  type Gateway,
  type LedgerAction,
  type PlainValue,
} from "@openomni/protocol";
import type { createExistingAgentMessaging } from "./messaging/send";
import type { externalMessage } from "./external-message";
import type { GatewayRouterPorts } from "./message-ports";
import { answerNativeRequest, openNativeRequest } from "./request/native";
import { executeRequestRoute, requireRoutedDecision } from "./routing-execution";

interface MessageContext {
  sender: Gateway.IngestSender;
  send: Gateway.SendMessage;
  prepared: ReturnType<GatewayRouterPorts["prepare"]>;
  external: ReturnType<typeof externalMessage> | undefined;
  ports: GatewayRouterPorts;
  messaging: ReturnType<typeof createExistingAgentMessaging> | undefined;
  messageId: string;
  handle: Gateway.SendMessageHandle;
  startedAt: number;
  clock: () => number;
  admitReplyGrant: () => void;
}

interface MessageProgress {
  commitMs: number;
  committed: Inbox.Row | undefined;
}

function transformedContent(
  intent: LedgerAction.Receipt,
  sender: Gateway.IngestSender,
  send: Gateway.SendMessage,
  messageId: string,
): string {
  if (sender.kind === "session" && intent.action.sessionId !== sender.id)
    throw new Error("authenticated session sender mismatch");
  const stored = intent.action.intent.value;
  if (stored === null || typeof stored !== "object" || Array.isArray(stored))
    throw new Error("message intent is not an object");
  const transformed = stored.value;
  if (transformed === null || typeof transformed !== "object" || Array.isArray(transformed))
    throw new Error("message intent value is not an object");
  const { content, ...routing } = transformed;
  const { content: _content, ...originalRouting } = { messageId, sender, ...send };
  if (canonicalDigest(routing) !== canonicalDigest(originalRouting))
    throw new Error("message routing transform requires readmission");
  if (typeof content !== "string") throw new Error("message transformed content is not text");
  return content;
}

function inboxAdmission(
  context: MessageContext,
  intent: LedgerAction.Receipt,
  content: string,
  commitAt: number,
): Inbox.Commit {
  const { sender, send, prepared, messageId, external } = context;
  return {
    id: messageId,
    sessionId: prepared.target,
    kind: send.type === "message" ? "prompt" : send.type,
    content,
    createdAt: commitAt,
    parentActionId: null,
    ...(prepared.sender === undefined ? {} : { sender: prepared.sender }),
    ...(prepared.createSession === undefined ? {} : { createSession: prepared.createSession }),
    ...(prepared.limits === undefined ? {} : { limits: prepared.limits }),
    origin: {
      encodingVersion: 1,
      value:
        prepared.origin ??
        (sender.kind === "session"
          ? Inbox.MessageOrigin.parse({
              kind: "message",
              messageId,
              senderSessionId: sender.id,
              sourceActionId: intent.action.id,
              ...(send.replyTo === undefined ? {} : { replyTo: send.replyTo }),
              ...(send.deadline === undefined ? {} : { deadline: send.deadline }),
            })
          : {
              kind: "external",
              messageId,
              surface: sender.surface,
              externalId: sender.externalId,
              actorId: external?.event.meta?.actor?.actorId ?? "",
            }),
    },
  };
}

/** Executes an admitted message; progress survives a later grant/projection failure. */
export async function executeMessage(
  context: MessageContext,
  progress: MessageProgress,
  intent: LedgerAction.Receipt,
): Promise<PlainValue> {
  const {
    sender,
    send,
    prepared,
    external,
    ports,
    messaging,
    messageId,
    handle,
    startedAt,
    clock,
  } = context;
  const content = transformedContent(intent, sender, send, messageId);
  if (external !== undefined) {
    const decision = requireRoutedDecision(external.route.decision);
    await executeRequestRoute(external.route, decision, ports.requests, content, clock());
    SurfaceKey.claim(external.surfaceKey, prepared.target);
    if (external.route.requestExecution.kind === "request")
      return { status: "executed", handle, delivery: { kind: "session" } };
  }
  if (send.to.kind === "actor") {
    if (messaging === undefined) throw new Error("actor messaging is not configured");
    const receipt = await messaging.send({
      messageId,
      traceId: intent.action.id,
      senderId: sender.kind === "session" ? sender.id : sender.externalId,
      target: { actorId: send.to.actorId },
      body: content,
      at: startedAt,
      operation: send.deadline === undefined ? "fire_and_forget" : "awaited",
      ...(send.deadline === undefined
        ? {}
        : {
            requestSpec: {
              requestId: intent.action.id,
              sessionId: intent.action.sessionId,
              allowedActions: ["report_result" as const],
              expectedResponders: [send.to.actorId],
              resolution: "first" as const,
              threshold: 1,
              deadline: send.deadline,
            },
          }),
    });
    if (receipt.kind === "denied") throw new Error(`actor send admission changed: ${receipt.code}`);
    return { status: "executed", handle, delivery: { kind: "actor", value: receipt.delivery } };
  }
  if (await answerNativeRequest(ports.requests, sender, prepared.origin, content, clock()))
    return { status: "executed", handle, delivery: { kind: "session" } };
  const commitAt = clock();
  const admission = inboxAdmission(context, intent, content, commitAt);
  await openNativeRequest(
    ports.requests,
    intent,
    sender,
    send,
    prepared.target,
    startedAt,
    admission,
  );
  const row = ports.inbox.commit(admission);
  progress.commitMs = clock() - commitAt;
  progress.committed = row;
  context.admitReplyGrant();
  return { status: "executed", handle, delivery: { kind: "session" } };
}

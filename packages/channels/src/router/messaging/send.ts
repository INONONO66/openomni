import type { z } from "zod";
import {
  Gateway,
  MessagingEvents,
  canonicalKey,
  type BusEvent,
  type SessionTransition,
} from "@openomni/protocol";
import { LedgerAppend } from "@openomni/ledger";
import type { GatewayRouterPorts } from "../message-ports.js";
import type { DeliveryReceipt } from "../../support/deliver";
import { authorizeSend } from "./authorize";
import { admitSend } from "./admission";

type DeliveryTarget = Gateway.DeliveryTarget;
type MessageDenialCode = Gateway.MessageDenialCode;
const SendInput = Gateway.SendInput;
type SendInput = z.infer<typeof SendInput>;
type SendReceipt = Gateway.SendReceipt;
type SendAuthorityInput = Parameters<typeof authorizeSend>[0];
type AuthorizedSend = Parameters<typeof admitSend>[0];

type OutboundMessage = Readonly<{
  messageId: string;
  idempotencyKey: string;
  senderId: string;
  operation: Gateway.MessageOperation;
  body: string;
  target: DeliveryTarget;
  requestId?: string;
}>;

type MessagingPorts = Readonly<{
  requests: GatewayRouterPorts["requests"];
  /** Delivery owners reconcile retries using the stable idempotency key. */
  deliver: (message: OutboundMessage) => DeliveryReceipt | Promise<DeliveryReceipt>;
  publish: BusEvent.Sink["publish"];
}> &
  Pick<NonNullable<GatewayRouterPorts["messaging"]>, "grants" | "budgets">;

type ExistingAgentMessaging = Readonly<{
  preflight: (input: SendAuthorityInput) => MessageDenialCode | undefined;
  send: (input: SendInput) => Promise<SendReceipt>;
}>;

/** Kernel records the original action suspension before the physical effect. */
function openSendRequest(
  input: SendInput,
  target: DeliveryTarget,
  ports: MessagingPorts,
): SessionTransition.Request | undefined {
  if (input.operation !== "awaited") return undefined;
  const spec = input.requestSpec as NonNullable<SendInput["requestSpec"]>;
  const recorded = ports.requests
    .list()
    .find(
      (candidate) =>
        candidate.requestId === spec.requestId && candidate.sessionId === spec.sessionId,
    );
  return ports.requests.open({
    ...spec,
    correlation: {
      ...spec.correlation,
      endpointId: target.endpointId,
      replyToMessageId: input.messageId,
    },
    at: recorded?.createdAt ?? input.at,
  });
}

/** Every retry reaches the physical driver's stable idempotency key. IDs are not receipts. */
async function deliverSend(
  input: SendInput,
  target: DeliveryTarget,
  request: SessionTransition.Request | undefined,
  ports: MessagingPorts,
): Promise<{
  readonly request: SessionTransition.Request | undefined;
  readonly value: "accepted" | "rejected" | "unknown";
}> {
  const delivery = await ports.deliver({
    messageId: input.messageId,
    idempotencyKey: input.messageId,
    senderId: input.senderId,
    operation: input.operation,
    body: input.body,
    target,
    ...(request === undefined ? {} : { requestId: request.requestId }),
  });
  if (request === undefined) return { request, value: delivery.value };
  const recorded = await ports.requests.receipt({
    inputId: canonicalKey([
      input.messageId,
      "delivery",
      delivery.value,
      delivery.externalMessageId ?? null,
      input.at,
    ]),
    requestId: request.requestId,
    sessionId: request.sessionId,
    sourceActionId: request.requestId,
    ...(delivery.externalMessageId === undefined
      ? {}
      : { externalMessageId: delivery.externalMessageId }),
    value: delivery.value,
    at: input.at,
  });
  return { request: recorded, value: delivery.value };
}

function recordSent(
  authorization: AuthorizedSend,
  delivered: Awaited<ReturnType<typeof deliverSend>>,
  ports: MessagingPorts,
): SendReceipt {
  const { input, target, grant } = authorization;
  const request = delivered.request;
  const delivery = delivered.value;
  ports.publish(MessagingEvents.Sent, {
    messageId: input.messageId,
    traceId: input.traceId,
    senderId: input.senderId,
    targetActorId: input.target.actorId,
    operation: input.operation,
    grantId: grant.id,
    endpointId: target.endpointId,
    ...(request === undefined ? {} : { requestId: request.requestId }),
    time: input.at,
  });
  if (request !== undefined) {
    return {
      kind: "sent",
      operation: "awaited",
      delivery,
      messageId: input.messageId,
      senderId: input.senderId,
      grantId: grant.id,
      target,
      request,
      at: input.at,
    };
  }
  return {
    kind: "sent",
    operation: "fire_and_forget",
    delivery,
    messageId: input.messageId,
    senderId: input.senderId,
    grantId: grant.id,
    target,
    at: input.at,
  };
}

/** Grant first, transactional admission/request opening second, physical delivery last. */
export function createExistingAgentMessaging(ports: MessagingPorts): ExistingAgentMessaging {
  function deny(input: SendInput, code: MessageDenialCode, reason: string): SendReceipt {
    ports.publish(MessagingEvents.Denied, {
      messageId: input.messageId,
      traceId: input.traceId,
      senderId: input.senderId,
      targetActorId: input.target.actorId,
      code,
      time: input.at,
    });
    return {
      kind: "denied",
      code,
      messageId: input.messageId,
      senderId: input.senderId,
      targetActorId: input.target.actorId,
      reason,
      at: input.at,
    };
  }

  async function send(rawInput: SendInput): Promise<SendReceipt> {
    const input = SendInput.parse(rawInput);
    const checked = authorizeSend(input, ports.grants());
    if (!checked.ok) return deny(input, checked.code, checked.reason);
    const authorization = { input, target: checked.target, grant: checked.grant };
    const { target } = authorization;
    // No promise may escape the admission/debit/request write unit.
    const opened = LedgerAppend.transaction(() => {
      const admission = admitSend(authorization, ports, deny);
      if ("kind" in admission) return { denied: admission };
      return { request: openSendRequest(input, target, ports) };
    });
    if (opened.denied !== undefined) return opened.denied;
    const request = await deliverSend(input, target, opened.request, ports);
    return recordSent(authorization, request, ports);
  }

  return {
    preflight(input) {
      const checked = authorizeSend(input, ports.grants());
      return checked.ok ? undefined : checked.code;
    },
    send,
  };
}

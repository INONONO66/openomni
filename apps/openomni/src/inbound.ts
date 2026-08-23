import { Channel, type Gateway, type Wait } from "@openomni/protocol";

function correlation(
  message: Channel.InboundMessage,
  descriptor: Channel.SurfaceKey.ParsedKey,
  threadId: string | undefined,
): Wait.Correlation {
  return {
    endpointId: descriptor.namespace || descriptor.surface,
    channelId: descriptor.id ?? message.surfaceKey,
    ...(message.replyToId === undefined ? {} : { replyToMessageId: message.replyToId }),
    ...(threadId === undefined ? {} : { threadId }),
    externalConversationId: message.surfaceKey,
  };
}

export function buildInboundEvent(message: Channel.InboundMessage): Gateway.DeliveredEvent {
  const descriptor = Channel.SurfaceKey.parse(message.surfaceKey);
  const threadId = message.threadId ?? descriptor.threadId;
  return {
    id: message.id,
    traceId: message.traceId,
    surface: descriptor.surface,
    ...(descriptor.namespace.length === 0 ? {} : { workspace: descriptor.namespace }),
    ...(descriptor.id === undefined ? {} : { channel: descriptor.id }),
    userId: message.sender.id,
    payload: message.text,
    meta: {
      actor: { role: "user", id: message.sender.id },
      surfaceKey: message.surfaceKey,
      kind: descriptor.kind,
      sender: message.sender,
      ...(message.replyToId === undefined ? {} : { replyToId: message.replyToId }),
      ...(threadId === undefined ? {} : { threadId }),
      ...(message.raw === undefined ? {} : { raw: message.raw }),
      agentName: "resident",
      correlation: correlation(message, descriptor, threadId),
    },
    mode: "direct",
  };
}

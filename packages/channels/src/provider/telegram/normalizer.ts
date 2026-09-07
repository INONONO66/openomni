import { type Channel, Gateway } from "@openomni/protocol";
import type { InboundNormalizer } from "../../types";
import type { TelegramMessage } from "./types";

export interface TelegramNormalizerContext {
  botId: string;
  botUsername: string;
}

export class TelegramNormalizer implements InboundNormalizer<TelegramMessage> {
  constructor(private readonly ctx: TelegramNormalizerContext) {}

  normalize(message: TelegramMessage): Channel.InboundMessage | null {
    const text = message.text;
    if (!text) return null;
    if (!message.from) return null;

    const userId = message.from.id;
    const chatId = String(message.chat.id);
    const addressees = (message.entities ?? []).flatMap((entity) => {
      if (entity.type === "text_mention" && entity.user !== undefined)
        return [{ externalId: String(entity.user.id) }];
      if (entity.type !== "mention") return [];
      const name = text.slice(entity.offset, entity.offset + entity.length);
      return [
        {
          externalId:
            name.toLowerCase() === `@${this.ctx.botUsername.toLowerCase()}` ? this.ctx.botId : name,
        },
      ];
    });
    const chain: string[] = [];
    for (let reply = message.reply_to_message; reply !== undefined; reply = reply.reply_to_message)
      chain.push(String(reply.message_id));

    return {
      sender: { kind: "external", surface: "telegram", externalId: String(userId) },
      facts: {
        eventId: String(message.message_id),
        surface: "telegram",
        channelId: chatId,
        addressees,
        dm: message.chat.type === "private",
        ...(message.reply_to_message
          ? { reply: { chain, replyToMessageId: String(message.reply_to_message.message_id) } }
          : {}),
        payload: Gateway.IngressFacts.shape.payload.parse(message),
        render: text,
      },
    };
  }
}

import { Channel } from "@openomni/protocol";
import { normalizeContent } from "../../support/trigger";
import type { InboundNormalizer } from "../../types";
import type { TelegramMessage } from "./types";

export interface TelegramNormalizerContext {
  botId: string;
  botUsername: string;
  triggers: Channel.Config["triggers"];
}

export class TelegramNormalizer implements InboundNormalizer<TelegramMessage> {
  constructor(private readonly ctx: TelegramNormalizerContext) {}

  normalize(message: TelegramMessage, traceId: string): Channel.InboundMessage | null {
    const text = message.text;
    if (!text) return null;
    if (!message.from) return null;

    const userId = message.from.id;
    const chatId = String(message.chat.id);

    const content = normalizeContent(text, this.ctx.triggers, this.ctx.botUsername);
    if (!content) return null;

    const surfaceKey = Channel.SurfaceKey.fromChannel({
      surface: "telegram",
      namespace: this.ctx.botId,
      kind: "chat",
      id: chatId,
    });

    return {
      id: String(message.message_id),
      traceId,
      surfaceKey,
      text: content,
      sender: {
        id: String(userId),
        name: message.from.username ?? message.from.first_name,
      },
      ...(message.reply_to_message
        ? { replyToId: String(message.reply_to_message.message_id) }
        : {}),
      raw: message,
    };
  }
}

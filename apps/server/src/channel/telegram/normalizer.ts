import type { Adapter } from "@openomni/protocol";
import { SurfaceKey } from "@openomni/session";
import { normalizeContent } from "../../shared/trigger";
import type { InboundNormalizer } from "../types";
import type { TelegramMessage } from "./types";

export interface TelegramNormalizerContext {
  botId: string;
  botUsername: string;
  triggers: Adapter.Config["triggers"];
}

export class TelegramNormalizer implements InboundNormalizer<TelegramMessage> {
  constructor(private readonly ctx: TelegramNormalizerContext) {}

  normalize(message: TelegramMessage): Adapter.InboundMessage | null {
    const text = message.text;
    if (!text) return null;
    if (!message.from) return null;

    const userId = message.from.id;
    const chatId = String(message.chat.id);

    const content = normalizeContent(text, this.ctx.triggers, this.ctx.botUsername);
    if (!content) return null;

    const surfaceKey = SurfaceKey.fromChannel({
      surface: "telegram",
      namespace: this.ctx.botId,
      kind: "chat",
      id: chatId,
    });

    return {
      id: String(message.message_id),
      surfaceKey,
      text: content,
      sender: {
        id: String(userId),
        name: message.from?.username ?? message.from?.first_name,
      },
      raw: message,
    };
  }
}

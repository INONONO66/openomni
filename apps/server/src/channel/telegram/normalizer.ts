import type { Adapter } from "@openomni/protocol";
import { SurfaceKey } from "@openomni/session";
import { evaluateTriggers, normalizeContent } from "../../shared/trigger";
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

    const userId = message.from?.id;
    const chatId = String(message.chat.id);
    const isDM = message.chat.type === "private";
    const mentioned = this.ctx.botUsername !== "" && text.includes(`@${this.ctx.botUsername}`);

    const ctx: Adapter.TriggerContext = {
      event: "message",
      mentioned,
      channelId: chatId,
      senderId: String(userId ?? 0),
      isDM,
      text,
    };

    if (!evaluateTriggers(this.ctx.triggers, ctx)) return null;

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
        id: String(userId ?? 0),
        name: message.from?.username ?? message.from?.first_name,
      },
      raw: message,
    };
  }
}

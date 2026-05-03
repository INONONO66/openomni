import type { Adapter } from "@openomni/protocol";
import { SurfaceKey } from "@openomni/session";
import { normalizeContent } from "../../shared/trigger";
import type { InboundNormalizer } from "../types";
import type { DiscordMessage } from "./types";

export interface DiscordNormalizerContext {
  botId: string;
  triggers: Adapter.Config["triggers"];
}

export class DiscordNormalizer implements InboundNormalizer<DiscordMessage> {
  constructor(private readonly ctx: DiscordNormalizerContext) {}

  normalize(message: DiscordMessage): Adapter.InboundMessage | null {
    if (message.author.bot) return null;
    if (!message.content) return null;

    const isDM = !message.guild_id;
    const mentioned = message.mentions?.some((u) => u.id === this.ctx.botId) ?? false;

    let content = message.content;
    if (mentioned && !isDM) {
      content = content.replace(new RegExp(`<@!?${this.ctx.botId}>\\s*`), "").trim();
    }
    content = normalizeContent(content, this.ctx.triggers);
    if (!content) return null;

    const surfaceKey = SurfaceKey.fromChannel({
      surface: "discord",
      namespace: this.ctx.botId,
      kind: isDM ? "dm" : "channel",
      id: isDM ? message.author.id : message.channel_id,
    });

    return {
      id: message.id,
      surfaceKey,
      text: content,
      sender: {
        id: message.author.id,
        name: message.author.username,
      },
      raw: message,
    };
  }
}

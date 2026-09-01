import { Channel } from "@openomni/protocol";
import { strippedMentionContent } from "../../support/trigger";
import type { InboundNormalizer } from "../../types";
import type { DiscordMessage } from "./types";

export interface DiscordNormalizerContext {
  botId: string;
  triggers: Channel.Config["triggers"];
}

export class DiscordNormalizer implements InboundNormalizer<DiscordMessage> {
  constructor(private readonly ctx: DiscordNormalizerContext) {}

  normalize(message: DiscordMessage, traceId: string): Channel.InboundMessage | null {
    if (message.author.bot) return null;
    if (!message.content) return null;

    const isDM = !message.guild_id;
    const mentioned = message.mentions?.some((u) => u.id === this.ctx.botId) ?? false;

    const content = strippedMentionContent(
      message.content,
      new RegExp(`<@!?${this.ctx.botId}>\\s*`, "g"),
      mentioned && !isDM,
      this.ctx.triggers,
    );
    if (!content) return null;

    const surfaceKey = Channel.SurfaceKey.fromChannel({
      surface: "discord",
      namespace: this.ctx.botId,
      kind: isDM ? "dm" : "channel",
      id: isDM ? message.author.id : message.channel_id,
    });

    return {
      id: message.id,
      traceId,
      surfaceKey,
      text: content,
      sender: {
        id: message.author.id,
        name: message.author.username,
      },
      ...(message.message_reference?.message_id
        ? { replyToId: message.message_reference.message_id }
        : {}),
      raw: message,
    };
  }
}

import type { Channel } from "@openomni/protocol";
import type { InboundNormalizer } from "../../types";
import type { DiscordMessage } from "./types";

export class DiscordNormalizer implements InboundNormalizer<DiscordMessage> {
  normalize(message: DiscordMessage): Channel.InboundMessage | null {
    if (message.author.bot) return null;
    if (!message.content) return null;

    const isDM = !message.guild_id;

    return {
      sender: { kind: "external", surface: "discord", externalId: message.author.id },
      facts: {
        eventId: message.id,
        surface: "discord",
        channelId: message.channel_id,
        ...(message.guild_id === undefined ? {} : { workspaceId: message.guild_id }),
        addressees: (message.mentions ?? []).map((user) => ({ externalId: user.id })),
        dm: isDM,
        ...(message.message_reference?.message_id
          ? {
              reply: {
                chain: [message.message_reference.message_id],
                replyToMessageId: message.message_reference.message_id,
              },
            }
          : {}),
        payload: message,
        render: message.content,
      },
    };
  }
}

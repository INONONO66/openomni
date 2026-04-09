import type { Adapter } from "@openomni/protocol";
import { splitText } from "../../shared/http-helpers";
import type { ChannelClient } from "../types";

const DISCORD_MESSAGE_LIMIT = 2000;

export class DiscordFormatter {
  async send(
    client: ChannelClient,
    channelId: string,
    message: Adapter.OutboundMessage,
  ): Promise<void> {
    if (!message.text) return;
    const chunks = splitText(message.text, DISCORD_MESSAGE_LIMIT);
    for (const chunk of chunks) {
      await client.send(channelId, chunk);
    }
  }
}

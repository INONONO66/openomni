import type { Adapter } from "@openomni/protocol";
import { splitText } from "../../shared/chunk-text";
import type { ChannelClient } from "../types";

const DISCORD_MESSAGE_LIMIT = 2000;

export async function sendDiscordMessage(
  client: ChannelClient,
  channelId: string,
  message: Adapter.OutboundMessage,
): Promise<void> {
  if (!message.text) return;
  for (const chunk of splitText(message.text, DISCORD_MESSAGE_LIMIT)) {
    await client.send(channelId, chunk);
  }
}

import { describe, expect, it } from "bun:test";
import { DiscordNormalizer } from "../src/provider/discord/normalizer";
import { TelegramNormalizer } from "../src/provider/telegram/normalizer";

describe("channel normalizers", () => {
  it("maps Discord message references to replyToId", () => {
    const normalizer = new DiscordNormalizer({ botId: "bot-1", triggers: [] });

    const message = normalizer.normalize(
      {
        id: "discord-in-1",
        channel_id: "dev",
        guild_id: "guild-1",
        author: { id: "seller-1", username: "Seller" },
        content: "tracking number",
        message_reference: { message_id: "discord-out-1" },
      },
      "trace-test",
    );

    expect(message).toMatchObject({
      id: "discord-in-1",
      surfaceKey: "discord:bot-1:channel:dev",
      replyToId: "discord-out-1",
    });
  });

  it("maps Telegram reply messages to replyToId", () => {
    const normalizer = new TelegramNormalizer({
      botId: "bot-1",
      botUsername: "openomni_bot",
      triggers: [],
    });

    const message = normalizer.normalize(
      {
        message_id: 12,
        chat: { id: 34, type: "group" },
        date: 1,
        from: { id: 56, is_bot: false, first_name: "Seller" },
        text: "tracking number",
        reply_to_message: {
          message_id: 11,
          chat: { id: 34, type: "group" },
          date: 1,
          from: { id: 78, is_bot: true, first_name: "OpenOmni" },
          text: "please report",
        },
      },
      "trace-test",
    );

    expect(message).toMatchObject({
      id: "12",
      surfaceKey: "telegram:bot-1:chat:34",
      replyToId: "11",
    });
  });
});

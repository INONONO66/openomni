import { describe, expect, test } from "bun:test";
import { DiscordNormalizer } from "../src/provider/discord/normalizer";
import { SlackNormalizer } from "../src/provider/slack/normalizer";
import { TelegramNormalizer } from "../src/provider/telegram/normalizer";

describe("provider ingress facts", () => {
  test("telegram preserves event identity, sender, reply chain, and render text", () => {
    const result = new TelegramNormalizer({
      botId: "bot-1",
      botUsername: "openomni_bot",
    }).normalize({
      message_id: 12,
      chat: { id: 34, type: "group" },
      date: 1,
      from: { id: 56, is_bot: false, first_name: "Seller", username: "seller_acct" },
      text: "tracking number",
      reply_to_message: {
        message_id: 11,
        chat: { id: 34, type: "group" },
        date: 1,
        from: { id: 78, is_bot: true, first_name: "OpenOmni" },
        text: "please report",
      },
    });

    expect(result?.facts).toMatchObject({
      eventId: "12",
      channelId: "34",
      reply: { chain: ["11"] },
      render: "tracking number",
    });
    expect(result?.sender.externalId).toBe("56");
  });

  test("discord preserves DM identity and content", () => {
    const result = new DiscordNormalizer().normalize({
      id: "discord-dm-1",
      channel_id: "dm-chan",
      author: { id: "owner-1", username: "Owner" },
      content: "status?",
    });

    expect(result?.facts).toMatchObject({
      eventId: "discord-dm-1",
      channelId: "dm-chan",
      dm: true,
      render: "status?",
    });
  });

  test("slack carries workspace, thread, and addressee facts", () => {
    const result = new SlackNormalizer({ botUserId: "UBOT", team: "T9" }).normalize({
      type: "message",
      channel: "C123",
      channel_type: "channel",
      user: "U77",
      text: "<@UBOT> tracking number",
      ts: "1710.0002",
      thread_ts: "1710.0001",
    });

    expect(result?.facts).toMatchObject({
      eventId: "1710.0002",
      workspaceId: "T9",
      channelId: "C123",
      addressees: [{ externalId: "T9:UBOT" }],
      reply: { chain: ["1710.0001"] },
      render: "<@UBOT> tracking number",
    });
    expect(result?.sender.externalId).toBe("T9:U77");
  });
});

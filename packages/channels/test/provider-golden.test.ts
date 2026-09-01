import { describe, expect, test } from "bun:test";
import { DiscordNormalizer } from "../src/discord/normalizer";
import type { DiscordMessage } from "../src/discord/types";
import { GitHubNormalizer } from "../src/github/normalizer";
import type { GitHubEventContent } from "../src/github/types";
import { SlackNormalizer } from "../src/slack/normalizer";
import type { SlackMessageEvent } from "../src/slack/types";
import { TelegramNormalizer } from "../src/telegram/normalizer";
import type { TelegramMessage } from "../src/telegram/types";

/**
 * Golden normalizer fixtures — exact-equality snapshots of the full
 * `Channel.InboundMessage` each provider produces from a representative raw
 * payload. Unlike the behavior suites (which pin single fields), these freeze
 * the whole normalized shape: a provider refactor that shifts any byte of the
 * wire-adjacent output fails here first.
 */

describe("provider golden fixtures", () => {
  test("telegram: group reply normalizes to the exact inbound shape", () => {
    const raw: TelegramMessage = {
      message_id: 12,
      chat: { id: 34, type: "group" },
      date: 1,
      from: { id: 56, is_bot: false, first_name: "Seller", username: "seller_acct" },
      text: "  tracking number 12-34  ",
      reply_to_message: {
        message_id: 11,
        chat: { id: 34, type: "group" },
        date: 1,
        from: { id: 78, is_bot: true, first_name: "OpenOmni" },
        text: "please report",
      },
    };
    const normalizer = new TelegramNormalizer({
      botId: "bot-1",
      botUsername: "openomni_bot",
      triggers: [],
    });

    expect(normalizer.normalize(raw, "trace-tg")).toEqual({
      id: "12",
      traceId: "trace-tg",
      surfaceKey: "telegram:bot-1:chat:34",
      text: "tracking number 12-34",
      sender: { id: "56", name: "seller_acct" },
      replyToId: "11",
      raw,
    });
  });

  test("discord: guild mention strips the bot tag and normalizes exactly", () => {
    const raw: DiscordMessage = {
      id: "discord-in-1",
      channel_id: "dev",
      guild_id: "guild-1",
      author: { id: "seller-1", username: "Seller" },
      content: "<@!bot-1> tracking number",
      mentions: [{ id: "bot-1", username: "OpenOmni" }],
      message_reference: { message_id: "discord-out-1" },
    };
    const normalizer = new DiscordNormalizer({ botId: "bot-1", triggers: [{ type: "mention" }] });

    expect(normalizer.normalize(raw, "trace-dc")).toEqual({
      id: "discord-in-1",
      traceId: "trace-dc",
      surfaceKey: "discord:bot-1:channel:dev",
      text: "tracking number",
      sender: { id: "seller-1", name: "Seller" },
      replyToId: "discord-out-1",
      raw,
    });
  });

  test("discord: DM keys the surface by author and keeps content verbatim", () => {
    const raw: DiscordMessage = {
      id: "discord-dm-1",
      channel_id: "dm-chan",
      author: { id: "owner-1", username: "Owner" },
      content: "status?",
    };
    const normalizer = new DiscordNormalizer({ botId: "bot-1", triggers: [] });

    expect(normalizer.normalize(raw, "trace-dm")).toEqual({
      id: "discord-dm-1",
      traceId: "trace-dm",
      surfaceKey: "discord:bot-1:dm:owner-1",
      text: "status?",
      sender: { id: "owner-1", name: "Owner" },
      raw,
    });
  });

  test("slack: threaded channel mention strips the bot tag and normalizes exactly", () => {
    const raw: SlackMessageEvent = {
      type: "message",
      channel: "C123",
      channel_type: "channel",
      user: "U77",
      text: "<@UBOT> tracking number",
      ts: "1710.0002",
      thread_ts: "1710.0001",
    };
    const normalizer = new SlackNormalizer({
      botUserId: "UBOT",
      team: "T9",
      triggers: [{ type: "mention" }],
    });

    expect(normalizer.normalize(raw, "trace-sl")).toEqual({
      id: "1710.0002",
      traceId: "trace-sl",
      surfaceKey: "slack:T9:channel:C123:thread:1710.0001",
      text: "tracking number",
      sender: { id: "T9:U77" },
      threadId: "1710.0001",
      raw,
    });
  });

  test("slack: DM keys the surface by user and carries the workspace-mandatory sender id", () => {
    const raw: SlackMessageEvent = {
      type: "message",
      channel: "D42",
      channel_type: "im",
      user: "U5",
      text: "status?",
      ts: "1710.0009",
    };
    const normalizer = new SlackNormalizer({ botUserId: "UBOT", team: "T9", triggers: [] });

    expect(normalizer.normalize(raw, "trace-sl-dm")).toEqual({
      id: "1710.0009",
      traceId: "trace-sl-dm",
      surfaceKey: "slack:T9:dm:U5",
      text: "status?",
      sender: { id: "T9:U5" },
      raw,
    });
  });

  test("github: issue comment with delivery id normalizes exactly", () => {
    const raw: GitHubEventContent = {
      repo: "openomni/project",
      issueKind: "issue",
      issueNumber: 7,
      sender: "octocat",
      senderType: "User",
      text: "@omni-bot please review",
      labels: ["bug"],
    };
    const normalizer = new GitHubNormalizer({ triggers: [], botUsername: "omni-bot" });

    expect(
      normalizer.normalize(raw, "issue_comment.created", "trace-gh", "delivery-abc"),
    ).toEqual({
      id: "delivery-abc",
      traceId: "trace-gh",
      surfaceKey: "github:openomni/project:channel:issue-7",
      text: "please review",
      sender: { id: "octocat", name: "octocat" },
      threadId: "issue-7",
      raw,
    });
  });

  test("github: missing delivery id falls back to the digest-stable synthetic id", () => {
    const raw: GitHubEventContent = {
      repo: "openomni/project",
      issueKind: "pr",
      issueNumber: 21,
      sender: "octocat",
      senderType: "User",
      text: "retry this",
      labels: [],
    };
    const normalizer = new GitHubNormalizer({ triggers: [] });

    const first = normalizer.normalize(raw, "issue_comment.created", "trace-gh-1");
    const second = normalizer.normalize(raw, "issue_comment.created", "trace-gh-2");
    expect(first?.id).toBe(second?.id ?? "");
    expect(first?.id).toMatch(/^issue_comment\.created-21-octocat-[0-9a-f]{12}$/);
    expect(first?.surfaceKey).toBe("github:openomni/project:channel:pr-21");
  });
});

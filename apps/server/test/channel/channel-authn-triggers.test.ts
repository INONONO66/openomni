import { describe, expect, it } from "bun:test";
import type { Channel } from "@openomni/protocol";
import type { ChannelAuthnDecisionObserver } from "../../src/channel/authn/types";
import { ChannelAuthnMiddleware } from "../../src/channel/channel-authn";

type ChannelAuthnDecision = Parameters<ChannelAuthnDecisionObserver>[0];

describe("channel-authn trigger policy", () => {
  it("allows Discord mentions and records trigger metadata", () => {
    const decisions: ChannelAuthnDecision[] = [];

    const auth = ChannelAuthnMiddleware.authenticateDiscordTriggers({
      triggers: [{ type: "mention" }, { type: "sender", allow: ["user-1"] }],
      ctx: messageContext({ mentioned: true, senderId: "user-1" }),
      onDecision: (decision) => {
        decisions.push(decision);
      },
    });

    expect(auth.verdict.verdict).toBe("allow");
    expect(decisions).toEqual([
      expect.objectContaining({
        name: "channel-authn:discord-triggers",
        policyId: "guardrail.permission",
        verdict: "allow",
        reason: "discord trigger accepted",
        metadata: expect.objectContaining({
          surface: "discord",
          event: "message",
          senderId: "user-1",
          triggerRuleCount: 2,
        }),
      }),
    ]);
  });

  it("denies Telegram sender misses through Policy.evaluate", () => {
    const decisions: ChannelAuthnDecision[] = [];

    const auth = ChannelAuthnMiddleware.authenticateTelegramTriggers({
      triggers: [{ type: "sender", allow: ["allowed-user"] }],
      ctx: messageContext({ senderId: "other-user", channelId: "chat-1" }),
      onDecision: (decision) => {
        decisions.push(decision);
      },
    });

    expect(auth.verdict.verdict).toBe("deny");
    expect(decisions).toEqual([
      expect.objectContaining({
        name: "channel-authn:telegram-triggers",
        policyId: "guardrail.permission",
        verdict: "deny",
        reason: "telegram trigger denied",
        metadata: expect.objectContaining({
          surface: "telegram",
          channelId: "chat-1",
          senderId: "other-user",
        }),
      }),
    ]);
  });

  it("preserves GitHub event, label, and empty-rule trigger semantics", () => {
    const accepted = ChannelAuthnMiddleware.authenticateGitHubTriggers({
      triggers: [
        { type: "event", events: ["issue_comment.created"] },
        { type: "label", values: ["openomni"] },
      ],
      ctx: githubContext({ labels: ["openomni"] }),
    });
    const denied = ChannelAuthnMiddleware.authenticateGitHubTriggers({
      triggers: [{ type: "event", events: ["issues.opened"] }],
      ctx: githubContext({}),
    });
    const emptyRules = ChannelAuthnMiddleware.authenticateGitHubTriggers({
      triggers: [],
      ctx: githubContext({}),
    });

    expect(accepted.verdict.verdict).toBe("allow");
    expect(denied.verdict.verdict).toBe("deny");
    expect(emptyRules.verdict.verdict).toBe("allow");
  });
});

function messageContext(overrides: Partial<Channel.TriggerContext>): Channel.TriggerContext {
  return {
    event: "message",
    mentioned: false,
    channelId: "channel-1",
    senderId: "user-1",
    isDM: false,
    text: "hello",
    ...overrides,
  };
}

function githubContext(overrides: Partial<Channel.TriggerContext>): Channel.TriggerContext {
  return {
    event: "issue_comment.created",
    mentioned: false,
    channelId: "issue-7",
    senderId: "octocat",
    labels: [],
    text: "@openomni run",
    ...overrides,
  };
}

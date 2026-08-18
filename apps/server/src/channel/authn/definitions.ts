import type { Policy } from "@openomni/protocol";

export const authTiming: Policy.Timing = "run.start";

export const WebSocketToken = {
  name: "channel-authn:websocket-token",
  priority: 0,
  failPolicy: "fail-closed",
} satisfies Policy.Definition;

export const GitHubHmac = {
  name: "channel-authn:github-hmac",
  priority: 0,
  failPolicy: "fail-closed",
} satisfies Policy.Definition;

export const DiscordTriggers = {
  name: "channel-authn:discord-triggers",
  priority: 0,
  failPolicy: "fail-closed",
} satisfies Policy.Definition;

export const TelegramTriggers = {
  name: "channel-authn:telegram-triggers",
  priority: 0,
  failPolicy: "fail-closed",
} satisfies Policy.Definition;

export const GitHubTriggers = {
  name: "channel-authn:github-triggers",
  priority: 0,
  failPolicy: "fail-closed",
} satisfies Policy.Definition;

import type { Policy } from "@openomni/protocol";

export const authTiming: Policy.Timing = "run.start";

export const WebSocketToken = {
  name: "channel-authn:websocket-token",
  timing: authTiming,
  priority: 0,
  failPolicy: "fail-closed",
} satisfies Policy.Definition;

export const GitHubHmac = {
  name: "channel-authn:github-hmac",
  timing: authTiming,
  priority: 0,
  failPolicy: "fail-closed",
} satisfies Policy.Definition;

export const DiscordTriggers = {
  name: "channel-authn:discord-triggers",
  timing: authTiming,
  priority: 0,
  failPolicy: "fail-closed",
} satisfies Policy.Definition;

export const TelegramTriggers = {
  name: "channel-authn:telegram-triggers",
  timing: authTiming,
  priority: 0,
  failPolicy: "fail-closed",
} satisfies Policy.Definition;

export const GitHubTriggers = {
  name: "channel-authn:github-triggers",
  timing: authTiming,
  priority: 0,
  failPolicy: "fail-closed",
} satisfies Policy.Definition;

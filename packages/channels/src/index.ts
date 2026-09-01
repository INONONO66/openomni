export { DiscordAdapter } from "./provider/discord/surface.js";
export { DiscordNormalizer } from "./provider/discord/normalizer.js";
export { TelegramAdapter } from "./provider/telegram/surface.js";
export { GitHubAdapter } from "./provider/github/surface.js";
export { SlackAdapter } from "./provider/slack/surface.js";
export { SlackNormalizer } from "./provider/slack/normalizer.js";
export { WebSocketHandler } from "./websocket.js";
export type {
  ChannelProvider,
  IngestMode,
  ProviderCapabilities,
  ProviderDeliveryRoute,
  ProviderRuntime,
} from "./provider/contract.js";
export { ChannelProviders } from "./provider/registry.js";
export { type TelegramCredentials, TelegramProvider } from "./provider/telegram/provider.js";
export { type DiscordCredentials, DiscordProvider } from "./provider/discord/provider.js";
export { type GitHubCredentials, GitHubProvider } from "./provider/github/provider.js";
export { type SlackCredentials, SlackProvider } from "./provider/slack/provider.js";
export { createGatewayRouter } from "./router/index.js";
export { resolveChannelGrant } from "./router/channel-grant.js";
export { WaitService } from "./router/wait/index.js";
export type { ChannelDeliveryRoute, GatewayRouter } from "./router/index.js";
export type { ExistingAgentMessaging } from "./router/messaging/send.js";
export type { PublishPort } from "./types.js";

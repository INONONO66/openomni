export { DiscordAdapter } from "./discord/surface.js";
export { DiscordNormalizer } from "./discord/normalizer.js";
export { TelegramAdapter } from "./telegram/surface.js";
export { GitHubAdapter } from "./github/surface.js";
export { SlackAdapter } from "./slack/surface.js";
export { SlackNormalizer } from "./slack/normalizer.js";
export { WebSocketHandler } from "./websocket.js";
export type {
  ChannelProvider,
  IngestMode,
  ProviderCapabilities,
  ProviderDeliveryRoute,
  ProviderRuntime,
} from "./provider/contract.js";
export { ChannelProviders } from "./provider/registry.js";
export { type TelegramCredentials, TelegramProvider } from "./telegram/provider.js";
export { type DiscordCredentials, DiscordProvider } from "./discord/provider.js";
export { type GitHubCredentials, GitHubProvider } from "./github/provider.js";
export { type SlackCredentials, SlackProvider } from "./slack/provider.js";
export { createGatewayRouter } from "./router/index.js";
export { resolveChannelGrant } from "./router/channel-grant.js";
export { WaitService } from "./router/wait/index.js";
export type { ChannelDeliveryRoute, GatewayRouter } from "./router/index.js";
export type { ExistingAgentMessaging } from "./router/messaging/send.js";
export type { PublishPort } from "./types.js";

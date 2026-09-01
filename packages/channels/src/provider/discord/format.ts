import { renderDiscordMarkdown } from "../../support/format/discord.js";
import type { RenderPolicy } from "../contract.js";

/**
 * Discord outbound policy — single source: the provider declares it and the
 * surface applies it. 2000 is the message content limit for bots.
 */
export const DISCORD_RENDER = {
  renderMarkdown: renderDiscordMarkdown,
  messageLimit: 2000,
} as const satisfies RenderPolicy;

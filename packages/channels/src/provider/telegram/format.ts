import { renderTelegramMarkdown } from "../../support/format/telegram.js";
import type { RenderPolicy } from "../contract.js";

/**
 * Telegram outbound policy — single source: the provider declares it and the
 * surface applies it. 4096 is the Bot API `sendMessage` text limit.
 */
export const TELEGRAM_RENDER = {
  renderMarkdown: renderTelegramMarkdown,
  messageLimit: 4096,
} as const satisfies RenderPolicy;

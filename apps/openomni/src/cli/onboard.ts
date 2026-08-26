import type { EnvEntry } from "./env-file";

/**
 * Interactive first-run setup. Answers become `~/.openomni/env` entries —
 * exactly the variables `loadConfig` already reads; onboarding introduces
 * no new configuration vocabulary.
 */
export interface AskOptions {
  readonly fallback?: string;
  readonly required?: boolean;
  /** Secret values must not echo to the terminal. */
  readonly secret?: boolean;
}

export type Ask = (question: string, options?: AskOptions) => Promise<string>;

async function askRequired(
  ask: Ask,
  question: string,
  extra?: { readonly fallback?: string; readonly secret?: boolean },
): Promise<string> {
  const fallback = extra?.fallback;
  const options: AskOptions =
    fallback === undefined
      ? { required: true, secret: extra?.secret }
      : { fallback, secret: extra?.secret };
  const answer = (await ask(question, options)).trim();
  if (answer.length > 0) return answer;
  if (fallback !== undefined) return fallback;
  throw new Error(`${question} is required`);
}

export async function gatherOnboarding(ask: Ask): Promise<readonly EnvEntry[]> {
  const provider = await askRequired(ask, "Model provider (anthropic | openai)", {
    fallback: "anthropic",
  });
  const modelId = await askRequired(ask, "Model id");
  const apiKey = await askRequired(ask, "Model API key", { secret: true });
  const port = await askRequired(ask, "WebSocket port", { fallback: "3000" });
  // Port 0 would bind an ephemeral, undiscoverable port under the daemon.
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error("WebSocket port must be an integer from 1 to 65535");
  }

  const entries: EnvEntry[] = [
    { key: "OPENOMNI_MODEL_PROVIDER", value: provider },
    { key: "OPENOMNI_MODEL_ID", value: modelId },
    { key: "OPENOMNI_MODEL_API_KEY", value: apiKey },
    { key: "OPENOMNI_WS_PORT", value: port },
  ];

  const optional: readonly { readonly key: string; readonly question: string }[] = [
    { key: "DISCORD_BOT_TOKEN", question: "Discord bot token (optional)" },
    { key: "TELEGRAM_BOT_TOKEN", question: "Telegram bot token (optional)" },
    { key: "GITHUB_WEBHOOK_SECRET", question: "GitHub webhook secret (optional)" },
  ];
  for (const { key, question } of optional) {
    const value = (await ask(question, { secret: true })).trim();
    if (value.length > 0) entries.push({ key, value });
  }
  return entries;
}

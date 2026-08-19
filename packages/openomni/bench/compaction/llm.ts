/**
 * Minimal OpenAI-compatible chat client for the bench. Reads the standard
 * env pair (`OPENAI_BASE_URL`, `OPENAI_API_KEY`) — in this operation that
 * points at the operator's token-hub router; any OpenAI-compatible endpoint
 * works. No SDK: the bench's calls are plain one-shot completions and the
 * dependency surface stays zero.
 */
export interface ChatOptions {
  readonly model: string;
  readonly system?: string;
  readonly user: string;
  readonly maxTokens?: number;
}

const BASE_URL = process.env.OPENAI_BASE_URL;
const API_KEY = process.env.OPENAI_API_KEY;

export function requireEnv(): void {
  if (!BASE_URL || !API_KEY) {
    throw new Error(
      "compaction live bench needs OPENAI_BASE_URL and OPENAI_API_KEY (an OpenAI-compatible endpoint, e.g. your token hub)",
    );
  }
}

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}
export const usage: Record<string, Usage> = {};

function track(model: string, u: { prompt_tokens?: number; completion_tokens?: number }): void {
  usage[model] ??= { calls: 0, inputTokens: 0, outputTokens: 0 };
  const bucket = usage[model];
  bucket.calls += 1;
  bucket.inputTokens += u.prompt_tokens ?? 0;
  bucket.outputTokens += u.completion_tokens ?? 0;
}

export async function chat(options: ChatOptions, attempt = 0): Promise<string> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens ?? 512,
      messages: [
        ...(options.system ? [{ role: "system", content: options.system }] : []),
        { role: "user", content: options.user },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string; code?: string };
  };
  if (!response.ok || body.error || !body.choices?.[0]?.message) {
    const message = body.error?.message ?? `http ${response.status}`;
    if (attempt < 3) {
      await Bun.sleep(1500 * (attempt + 1));
      return chat(options, attempt + 1);
    }
    throw new Error(`chat failed after retries: ${message}`);
  }
  track(options.model, body.usage ?? {});
  return body.choices[0].message.content ?? "";
}

/** Bounded-concurrency map that preserves order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

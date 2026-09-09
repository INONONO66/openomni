import { z } from "zod";

// Invalid-but-present counters remain present as undefined: aliases cannot repair contradictions.
const Count = z.number().int().nonnegative().safe().optional().catch(undefined);
const InputDetails = z.object({ cacheReadTokens: Count, cacheWriteTokens: Count }).catch({});
const OutputDetails = z.object({ reasoningTokens: Count }).catch({});
const Usage = z.object({
  inputTokens: Count,
  input_tokens: Count,
  promptTokens: Count,
  prompt_tokens: Count,
  outputTokens: Count,
  output_tokens: Count,
  completionTokens: Count,
  completion_tokens: Count,
  reasoningTokens: Count,
  reasoning_tokens: Count,
  cachedInputTokens: Count,
  cacheReadTokens: Count,
  cache_read_input_tokens: Count,
  cacheWriteTokens: Count,
  cache_creation_input_tokens: Count,
  inputTokenDetails: InputDetails,
  outputTokenDetails: OutputDetails,
  raw: z.object({ completion_tokens_details: z.object({ reasoning_tokens: Count }).catch({}) })
    .catch({ completion_tokens_details: {} }),
}).catch({ inputTokenDetails: {}, outputTokenDetails: {}, raw: { completion_tokens_details: {} } });
const Metadata = z.object({
  anthropic: z.object({ reasoningTokens: Count, cacheReadInputTokens: Count, cacheCreationInputTokens: Count }).catch({}),
  openai: z.object({ reasoningTokens: Count, cachedPromptTokens: Count }).catch({}),
}).catch({ anthropic: {}, openai: {} });

export const UsageResponse = z.object({ usage: Usage, providerMetadata: Metadata });

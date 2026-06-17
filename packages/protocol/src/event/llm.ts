import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { Token } from "../token/index.js";

const Base = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  runId: z.string().optional(),
  time: z.number(),
});

export namespace LlmCall {
  export const Started = BusEvent.define(
    "llm.call.started",
    Base.extend({
      provider: z.string(),
      model: z.string(),
      messageCount: z.number(),
      toolCount: z.number(),
    }),
  );

  export const Completed = BusEvent.define(
    "llm.call.completed",
    Base.extend({
      provider: z.string(),
      model: z.string(),
      durationMs: z.number(),
      inputTokens: Token.Count,
      outputTokens: Token.Count,
      reasoningTokens: Token.Count.default(0),
      cacheReadTokens: Token.Count.default(0),
      cacheWriteTokens: Token.Count.default(0),
      finishReason: z.string(),
    }),
  );

  export const RetryDecided = BusEvent.define(
    "llm.call.retry.decided",
    Base.extend({
      attempt: z.number(),
      maxAttempts: z.number(),
      reason: z.string(),
      backoffMs: z.number(),
    }),
  );

  export const RateLimited = BusEvent.define(
    "llm.rate.limited",
    Base.extend({
      provider: z.string(),
      retryAfterMs: z.number(),
    }),
  );
}

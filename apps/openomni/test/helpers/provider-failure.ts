import { Run } from "@openomni/llm";

export function providerFailure(
  message: string,
  cause: Error = Object.assign(new Error(message), {
    name: "AI_APICallError",
    isRetryable: true,
    statusCode: 529,
    responseHeaders: { "retry-after-ms": "0" },
  }),
): Run.Failure {
  return new Run.FailureError(
    {
      message,
      aborted: cause.name === "AbortError",
      contextOverflow: false,
      visibleOutput: false,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    { cause },
  );
}

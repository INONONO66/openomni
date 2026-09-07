import { describe, expect, test } from "bun:test";
import { APIError } from "../../src/error";
import { Run } from "../../src/run";
import { Retry } from "../../src/retry";

/** An AI SDK provider error as the SDK raises it: facts on the object itself. */
function sdkError(fields: {
  readonly message: string;
  readonly isRetryable: boolean;
  readonly statusCode?: number;
  readonly responseBody?: string;
}): Error {
  return Object.assign(new Error(fields.message), {
    name: "AI_APICallError",
    isRetryable: fields.isRetryable,
    ...(fields.statusCode === undefined ? {} : { statusCode: fields.statusCode }),
    ...(fields.responseBody === undefined ? {} : { responseBody: fields.responseBody }),
  });
}

function runFailure(cause: unknown): Run.Failure {
  return new Run.FailureError(
    {
      message: "the model call failed",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      aborted: false,
      contextOverflow: false,
    },
    { cause },
  );
}

describe("Retry.classifyFailure", () => {
  test("classifies a typed APIError directly", () => {
    expect(
      Retry.classifyFailure(
        new APIError({ message: "rate limited", isRetryable: true, statusCode: 429 }),
      ),
    ).toBe("rate_limit");
  });

  test("coerces a raw AI SDK provider error", () => {
    expect(
      Retry.classifyFailure(
        sdkError({ message: "rate limited", isRetryable: true, statusCode: 429 }),
      ),
    ).toBe("rate_limit");
  });

  test("walks the cause chain of the package's own terminal failure", () => {
    const failure = runFailure(
      new APIError({ message: "insufficient_quota", isRetryable: true, statusCode: 429 }),
    );

    expect(Retry.classifyFailure(failure)).toBe("billing");
  });

  test("walks a nested cause chain rather than stopping at the first wrapper", () => {
    const wrapped = new Error("agent run failed", {
      cause: runFailure(
        sdkError({ message: "insufficient_quota", isRetryable: true, statusCode: 429 }),
      ),
    });

    expect(Retry.classifyFailure(wrapped)).toBe("billing");
  });

  test("classifies a declined-card billing error as terminal", () => {
    expect(
      Retry.classifyFailure(
        new APIError({
          message: "billing_error: card declined",
          isRetryable: false,
          statusCode: 402,
        }),
      ),
    ).toBe("billing");
  });

  test("reports non_retryable for an error carrying no provider facts", () => {
    expect(Retry.classifyFailure(new Error("socket hang up"))).toBe("non_retryable");
  });

  test("terminates on a self-referential cause chain", () => {
    const looping = new Error("loop");
    (looping as { cause?: unknown }).cause = looping;

    expect(Retry.classifyFailure(looping)).toBe("non_retryable");
  });
});

describe("Retry content-policy classification", () => {
  test.each([
    {
      name: "an OpenAI content_policy_violation code",
      input: {
        message: JSON.stringify({
          error: { type: "invalid_request_error", code: "content_policy_violation" },
        }),
        isRetryable: false,
        statusCode: 400,
      },
    },
    {
      name: "an Anthropic content-filter refusal in the body",
      input: {
        message: "Request failed",
        isRetryable: false,
        statusCode: 400,
        responseBody: JSON.stringify({ error: { type: "content_filter" } }),
      },
    },
    {
      name: "a moderation-blocked prose message",
      input: {
        message: "The request was blocked by our content policy",
        isRetryable: false,
        statusCode: 400,
      },
    },
  ])("$name classifies as content_policy", ({ input }) => {
    expect(Retry.classifyFailure(new APIError(input))).toBe("content_policy");
  });

  test("a content-policy refusal is terminal, never retried", () => {
    const decision = Retry.decide(
      1,
      new APIError({
        message: "The request was blocked by our content policy",
        isRetryable: true,
        statusCode: 400,
      }),
    );

    expect(decision.retry).toBe(false);
    if (decision.retry) expect.unreachable("a content-policy refusal must not be retryable");
    expect(decision.reason).toBe("content_policy");
    expect(decision.detail).toBeDefined();
  });

  test("does not confuse a policy DISCUSSION with a policy refusal", () => {
    // The prose names a policy without being a moderation verdict: a 500 that
    // merely mentions the words must stay on the server-error path.
    expect(
      Retry.classifyFailure(
        new APIError({
          message: "our content policy documentation service is unavailable",
          isRetryable: true,
          statusCode: 503,
        }),
      ),
    ).toBe("server_error");
  });
});

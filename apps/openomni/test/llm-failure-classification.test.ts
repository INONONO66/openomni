import { describe, expect, test } from "bun:test";
import { classifyTurnFailure } from "../src/observation/llm-failure";

function providerError(fields: {
  message: string;
  isRetryable: boolean;
  statusCode?: number;
  responseBody?: string;
}): Error {
  return Object.assign(new Error(fields.message), {
    name: "AI_APICallError",
    isRetryable: fields.isRetryable,
    ...(fields.statusCode === undefined ? {} : { statusCode: fields.statusCode }),
    ...(fields.responseBody === undefined ? {} : { responseBody: fields.responseBody }),
  });
}

describe("turn failure classification", () => {
  test("covers every provider failure class without exposing raw details", () => {
    const errors = [
      providerError({ message: "limited", isRetryable: true, statusCode: 429 }),
      providerError({ message: "billing_error", isRetryable: false, statusCode: 402 }),
      providerError({ message: "blocked by content policy", isRetryable: false, statusCode: 400 }),
      providerError({ message: JSON.stringify({ code: "quota_exhausted" }), isRetryable: true }),
      providerError({ message: "server", isRetryable: true, statusCode: 503 }),
      new Error("unclassified"),
    ];
    const results = errors.map(classifyTurnFailure);
    expect(new Set(results.map(({ reason }) => reason))).toEqual(
      new Set([
        "rate_limit",
        "billing",
        "content_policy",
        "overloaded",
        "server_error",
        "non_retryable",
      ]),
    );
  });

  test("payment status can be nested and cause walking is bounded", () => {
    expect(classifyTurnFailure({ cause: { data: { statusCode: 402 } } }).reason).toBe(
      "non_retryable",
    );
    let error: unknown = { statusCode: 402 };
    for (let index = 0; index < 9; index += 1) error = { cause: error };
    expect(classifyTurnFailure(error).reason).toBe("non_retryable");
  });
});

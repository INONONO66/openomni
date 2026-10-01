import { spyOn } from "bun:test";
import { APICallError } from "ai";
import { APIError } from "../../src/error";

export type SdkErrorInput = {
  readonly message: string;
  readonly isRetryable?: boolean;
  readonly statusCode?: number;
  readonly responseHeaders?: Record<string, string>;
  readonly responseBody?: string;
};

export function sdkError(input: SdkErrorInput): APICallError {
  return new APICallError({
    url: "https://provider.test/v1/messages",
    requestBodyValues: {},
    ...input,
  });
}

export const apiError = (input: SdkErrorInput) => new APIError({ cause: sdkError(input) });

export function rateLimitError(headers?: Record<string, string>) {
  return apiError({
    message: "rate limited",
    isRetryable: true,
    statusCode: 429,
    ...(headers && { responseHeaders: headers }),
  });
}

export function withRandom<T>(value: number, action: () => T): T {
  const random = spyOn(Math, "random").mockReturnValue(value);
  try {
    return action();
  } finally {
    random.mockRestore();
  }
}

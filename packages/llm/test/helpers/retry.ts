import { spyOn } from "bun:test";
import { APIError } from "../../src/error";

export type APIErrorInput = ConstructorParameters<typeof APIError>[0];
export const apiError = (input: APIErrorInput) => new APIError(input);

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

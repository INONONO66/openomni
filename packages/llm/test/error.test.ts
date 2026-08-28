import { describe, expect, test } from "bun:test";
import { NamedError, ProviderError, APIError, coerceApiError } from "../src/error";

describe("coerceApiError", () => {
  test("passes through protocol APIError instances", () => {
    const error = new APIError({ message: "boom", isRetryable: true });
    expect(coerceApiError(error)).toBe(error);
  });

  test("coerces AI SDK APICallError-shaped errors with lowercased headers", () => {
    const sdkError = Object.assign(new Error("Overloaded"), {
      name: "AI_APICallError",
      isRetryable: true,
      statusCode: 529,
      responseHeaders: { "Retry-After-Ms": "1200" },
      responseBody: '{"type":"error"}',
    });

    const coerced = coerceApiError(sdkError);

    expect(coerced).toBeDefined();
    expect(APIError.isInstance(coerced)).toBe(true);
    expect(coerced?.data).toMatchObject({
      message: "Overloaded",
      isRetryable: true,
      statusCode: 529,
      responseHeaders: { "retry-after-ms": "1200" },
      responseBody: '{"type":"error"}',
    });
    expect(coerced?.cause).toBe(sdkError);
  });

  test("returns undefined for errors without retry metadata", () => {
    expect(coerceApiError(new Error("plain"))).toBeUndefined();
    expect(coerceApiError("string error")).toBeUndefined();
    expect(coerceApiError(null)).toBeUndefined();
  });
});

describe("NamedError", () => {
  test("Unknown error", () => {
    const err = new NamedError.Unknown({ message: "something went wrong" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NamedError);
    expect(err.name).toBe("UnknownError");
    expect(err.data.message).toBe("something went wrong");
    expect(err.toObject()).toEqual({
      name: "UnknownError",
      data: { message: "something went wrong" },
    });
  });

  test("isInstance works", () => {
    const err = new NamedError.Unknown({ message: "test" });
    expect(NamedError.Unknown.isInstance(err)).toBe(true);
    expect(NamedError.Unknown.isInstance({ name: "UnknownError" })).toBe(false);
    expect(NamedError.Unknown.isInstance({ name: "Other" })).toBe(false);
    expect(NamedError.Unknown.isInstance(null)).toBe(false);
  });
});

describe("ProviderError", () => {
  test("construction and properties", () => {
    const err = new ProviderError({
      message: "unknown provider",
      provider: "gemini",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NamedError);
    expect(err.name).toBe("ProviderError");
    expect(err.data.message).toBe("unknown provider");
    expect(err.data.provider).toBe("gemini");
  });

  test("isInstance type guard", () => {
    const err = new ProviderError({ message: "test", provider: "x" });
    expect(ProviderError.isInstance(err)).toBe(true);
    expect(ProviderError.isInstance(new NamedError.Unknown({ message: "x" }))).toBe(false);
  });
});

describe("APIError", () => {
  test("construction with all fields", () => {
    const err = new APIError({
      message: "API request failed",
      statusCode: 500,
      isRetryable: true,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error": "internal server error"}',
      metadata: { requestID: "req_123" },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NamedError);
    expect(err.name).toBe("APIError");
    expect(err.data.message).toBe("API request failed");
    expect(err.data.statusCode).toBe(500);
    expect(err.data.isRetryable).toBe(true);
    expect(err.data.responseHeaders).toEqual({
      "content-type": "application/json",
    });
    expect(err.data.responseBody).toBe('{"error": "internal server error"}');
    expect(err.data.metadata).toEqual({ requestID: "req_123" });
  });

  test("construction with minimal fields", () => {
    const err = new APIError({
      message: "API error",
      isRetryable: false,
    });
    expect(err.data.message).toBe("API error");
    expect(err.data.isRetryable).toBe(false);
    expect(err.data.statusCode).toBeUndefined();
    expect(err.data.responseHeaders).toBeUndefined();
    expect(err.data.responseBody).toBeUndefined();
    expect(err.data.metadata).toBeUndefined();
  });

  test("toObject serialization", () => {
    const err = new APIError({
      message: "not found",
      statusCode: 404,
      isRetryable: false,
    });
    expect(err.toObject()).toEqual({
      name: "APIError",
      data: {
        message: "not found",
        statusCode: 404,
        isRetryable: false,
      },
    });
  });

  test("isInstance type guard", () => {
    const err = new APIError({ message: "test", isRetryable: true });
    expect(APIError.isInstance(err)).toBe(true);
    expect(APIError.isInstance(new NamedError.Unknown({ message: "x" }))).toBe(false);
  });
});

// #500 C3: moved from packages/protocol/test/error.test.ts with the schema.
describe("APIError", () => {
  test("parses the minimal shape", () => {
    const parsed = APIError.Schema.parse({
      name: "APIError",
      data: {
        message: "fail",
        isRetryable: true,
      },
    });

    expect(parsed).toEqual({
      name: "APIError",
      data: {
        message: "fail",
        isRetryable: true,
      },
    });
  });

  test("parses optional API metadata fields", () => {
    const parsed = APIError.Schema.parse({
      name: "APIError",
      data: {
        message: "fail",
        isRetryable: false,
        statusCode: 503,
        responseHeaders: { "content-type": "application/json" },
        responseBody: "{}",
        metadata: { requestId: "req-1" },
      },
    });

    expect(parsed.data).toEqual({
      message: "fail",
      isRetryable: false,
      statusCode: 503,
      responseHeaders: { "content-type": "application/json" },
      responseBody: "{}",
      metadata: { requestId: "req-1" },
    });
  });

  test("rejects missing isRetryable", () => {
    expect(() =>
      APIError.Schema.parse({
        name: "APIError",
        data: {
          message: "fail",
        },
      }),
    ).toThrow();
  });

  test("constructs and identifies APIError instances", () => {
    const error = new APIError({ message: "fail", isRetryable: false });

    expect(error.name).toBe("APIError");
    expect(error.message).toBe("fail");
    expect(APIError.isInstance(error)).toBe(true);
    expect(APIError.isInstance(new NamedError.Unknown({ message: "oops" }))).toBe(false);
  });
});

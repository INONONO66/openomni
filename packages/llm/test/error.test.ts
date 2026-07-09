import { describe, expect, test } from "bun:test";
import { NamedError, ProviderError, APIError } from "../src/error";

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
    expect(NamedError.Unknown.isInstance({ name: "UnknownError" })).toBe(true);
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

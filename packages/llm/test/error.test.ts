import { describe, expect, test } from "bun:test";
import {
  AuthError,
  NamedError,
  ProviderError,
  TokenRefreshError,
  SessionError,
  StreamError,
  RetryError,
  APIError,
  AbortedError,
  OutputLengthError,
} from "../src/error";

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

describe("AuthError", () => {
  test("construction and properties", () => {
    const err = new AuthError({ message: "auth failed", provider: "openai" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NamedError);
    expect(err.name).toBe("AuthError");
    expect(err.data.message).toBe("auth failed");
    expect(err.data.provider).toBe("openai");
  });

  test("toObject serialization", () => {
    const err = new AuthError({ message: "denied", provider: "anthropic" });
    expect(err.toObject()).toEqual({
      name: "AuthError",
      data: { message: "denied", provider: "anthropic" },
    });
  });

  test("isInstance type guard", () => {
    const err = new AuthError({ message: "test", provider: "openai" });
    expect(AuthError.isInstance(err)).toBe(true);
    expect(AuthError.isInstance(new ProviderError({ message: "x", provider: "y" }))).toBe(false);
  });

  test("schema is defined", () => {
    expect(AuthError.Schema).toBeDefined();
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
    expect(ProviderError.isInstance(new AuthError({ message: "x", provider: "y" }))).toBe(false);
  });
});

describe("TokenRefreshError", () => {
  test("construction and properties", () => {
    const err = new TokenRefreshError({
      message: "refresh failed",
      status: 401,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NamedError);
    expect(err.name).toBe("TokenRefreshError");
    expect(err.data.message).toBe("refresh failed");
    expect(err.data.status).toBe(401);
  });

  test("toObject serialization", () => {
    const err = new TokenRefreshError({ message: "expired", status: 403 });
    expect(err.toObject()).toEqual({
      name: "TokenRefreshError",
      data: { message: "expired", status: 403 },
    });
  });

  test("isInstance type guard", () => {
    const err = new TokenRefreshError({ message: "test", status: 500 });
    expect(TokenRefreshError.isInstance(err)).toBe(true);
    expect(TokenRefreshError.isInstance(new AuthError({ message: "x", provider: "y" }))).toBe(
      false,
    );
  });

  test("can be caught and inspected", () => {
    try {
      throw new TokenRefreshError({
        message: "Token refresh failed: 401",
        status: 401,
      });
    } catch (e) {
      expect(TokenRefreshError.isInstance(e)).toBe(true);
      if (TokenRefreshError.isInstance(e)) {
        expect(e.data.status).toBe(401);
      }
    }
  });
});

describe("SessionError", () => {
  test("construction with message and sessionID", () => {
    const err = new SessionError({
      message: "session expired",
      sessionID: "sess_123",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NamedError);
    expect(err.name).toBe("SessionError");
    expect(err.data.message).toBe("session expired");
    expect(err.data.sessionID).toBe("sess_123");
  });

  test("construction with message only", () => {
    const err = new SessionError({ message: "session error" });
    expect(err.name).toBe("SessionError");
    expect(err.data.message).toBe("session error");
    expect(err.data.sessionID).toBeUndefined();
  });

  test("toObject serialization", () => {
    const err = new SessionError({
      message: "session lost",
      sessionID: "sess_456",
    });
    expect(err.toObject()).toEqual({
      name: "SessionError",
      data: { message: "session lost", sessionID: "sess_456" },
    });
  });

  test("isInstance type guard", () => {
    const err = new SessionError({ message: "test" });
    expect(SessionError.isInstance(err)).toBe(true);
    expect(SessionError.isInstance(new AuthError({ message: "x", provider: "y" }))).toBe(false);
  });
});

describe("StreamError", () => {
  test("construction and properties", () => {
    const err = new StreamError({ message: "stream disconnected" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NamedError);
    expect(err.name).toBe("StreamError");
    expect(err.data.message).toBe("stream disconnected");
  });

  test("toObject serialization", () => {
    const err = new StreamError({ message: "connection lost" });
    expect(err.toObject()).toEqual({
      name: "StreamError",
      data: { message: "connection lost" },
    });
  });

  test("isInstance type guard", () => {
    const err = new StreamError({ message: "test" });
    expect(StreamError.isInstance(err)).toBe(true);
    expect(StreamError.isInstance(new SessionError({ message: "x" }))).toBe(false);
  });
});

describe("RetryError", () => {
  test("construction with all fields", () => {
    const err = new RetryError({
      message: "max retries exceeded",
      attempts: 5,
      lastError: "timeout",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NamedError);
    expect(err.name).toBe("RetryError");
    expect(err.data.message).toBe("max retries exceeded");
    expect(err.data.attempts).toBe(5);
    expect(err.data.lastError).toBe("timeout");
  });

  test("construction without lastError", () => {
    const err = new RetryError({ message: "retry failed", attempts: 3 });
    expect(err.data.message).toBe("retry failed");
    expect(err.data.attempts).toBe(3);
    expect(err.data.lastError).toBeUndefined();
  });

  test("toObject serialization", () => {
    const err = new RetryError({
      message: "failed after retries",
      attempts: 10,
      lastError: "network error",
    });
    expect(err.toObject()).toEqual({
      name: "RetryError",
      data: {
        message: "failed after retries",
        attempts: 10,
        lastError: "network error",
      },
    });
  });

  test("isInstance type guard", () => {
    const err = new RetryError({ message: "test", attempts: 1 });
    expect(RetryError.isInstance(err)).toBe(true);
    expect(RetryError.isInstance(new StreamError({ message: "x" }))).toBe(false);
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
    expect(APIError.isInstance(new RetryError({ message: "x", attempts: 1 }))).toBe(false);
  });
});

describe("AbortedError", () => {
  test("construction and properties", () => {
    const err = new AbortedError({ message: "operation aborted" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NamedError);
    expect(err.name).toBe("AbortedError");
    expect(err.data.message).toBe("operation aborted");
  });

  test("toObject serialization", () => {
    const err = new AbortedError({ message: "user cancelled" });
    expect(err.toObject()).toEqual({
      name: "AbortedError",
      data: { message: "user cancelled" },
    });
  });

  test("isInstance type guard", () => {
    const err = new AbortedError({ message: "test" });
    expect(AbortedError.isInstance(err)).toBe(true);
    expect(AbortedError.isInstance(new APIError({ message: "x", isRetryable: false }))).toBe(false);
  });
});

describe("OutputLengthError", () => {
  test("construction with empty data", () => {
    const err = new OutputLengthError({});
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NamedError);
    expect(err.name).toBe("OutputLengthError");
    expect(err.data).toEqual({});
  });

  test("toObject serialization", () => {
    const err = new OutputLengthError({});
    expect(err.toObject()).toEqual({
      name: "OutputLengthError",
      data: {},
    });
  });

  test("isInstance type guard", () => {
    const err = new OutputLengthError({});
    expect(OutputLengthError.isInstance(err)).toBe(true);
    expect(OutputLengthError.isInstance(new AbortedError({ message: "x" }))).toBe(false);
  });

  test("can be thrown and caught", () => {
    try {
      throw new OutputLengthError({});
    } catch (e) {
      expect(OutputLengthError.isInstance(e)).toBe(true);
    }
  });
});

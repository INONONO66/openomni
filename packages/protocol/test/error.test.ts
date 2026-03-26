import { describe, test, expect } from "bun:test";
import { z } from "zod";

import { NamedError, APIError } from "../src/error/index.js";

describe("NamedError.create", () => {
  const MyError = NamedError.create(
    "MyError",
    z.object({
      message: z.string(),
      detail: z.number(),
    }),
  );

  test("returns a class with static schema helpers", () => {
    expect(typeof MyError).toBe("function");
    expect(MyError.name).toBe("MyError");
    expect(MyError.Schema).toBeDefined();
    expect(MyError.isInstance).toBeDefined();
  });

  test("creates instances with message and data from payload", () => {
    const error = new MyError({ message: "boom", detail: 42 });

    expect(error.name).toBe("MyError");
    expect(error.message).toBe("boom");
    expect(error.data).toEqual({ message: "boom", detail: 42 });
  });

  test("falls back to the error name when payload has no message", () => {
    const NoMessageError = NamedError.create(
      "NoMessageError",
      z.object({
        detail: z.number(),
      }),
    );

    const error = new NoMessageError({ detail: 7 });

    expect(error.message).toBe("NoMessageError");
    expect(error.data).toEqual({ detail: 7 });
  });

  test("returns the schema and object shape", () => {
    const error = new MyError({ message: "shape", detail: 1 });

    expect(error.schema()).toBe(MyError.Schema);
    expect(error.toObject()).toEqual({
      name: "MyError",
      data: { message: "shape", detail: 1 },
    });
  });

  test("sets cause when provided", () => {
    const cause = new Error("cause");
    const error = new MyError({ message: "boom", detail: 1 }, { cause });

    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });

  test("isInstance matches real instances", () => {
    expect(MyError.isInstance(new MyError({ message: "ok", detail: 1 }))).toBe(true);
  });

  test("isInstance rejects null", () => {
    expect(MyError.isInstance(null)).toBe(false);
  });

  test("isInstance accepts plain objects with the same name", () => {
    expect(MyError.isInstance({ name: "MyError" })).toBe(true);
  });

  test("isInstance rejects plain objects with a different name", () => {
    expect(MyError.isInstance({ name: "OtherError" })).toBe(false);
  });
});

describe("NamedError.Unknown", () => {
  test("uses the built-in name and message field", () => {
    const error = new NamedError.Unknown({ message: "oops" });

    expect(error.name).toBe("UnknownError");
    expect(error.message).toBe("oops");
    expect(error.toObject()).toEqual({
      name: "UnknownError",
      data: { message: "oops" },
    });
  });

  test("parses valid objects and rejects missing message", () => {
    expect(
      NamedError.Unknown.Schema.parse({
        name: "UnknownError",
        data: { message: "test" },
      }),
    ).toEqual({
      name: "UnknownError",
      data: { message: "test" },
    });

    expect(() =>
      NamedError.Unknown.Schema.parse({
        name: "UnknownError",
        data: {},
      }),
    ).toThrow();
  });
});

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

describe("NamedError.create with non-object data", () => {
  test("falls back to the class name for string payloads", () => {
    const StrError = NamedError.create("StrError", z.string());
    const error = new StrError("just a string");

    expect(error.message).toBe("StrError");
    expect(error.data).toBe("just a string");
    expect(error.toObject()).toEqual({
      name: "StrError",
      data: "just a string",
    });
  });
});

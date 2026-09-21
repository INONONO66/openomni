import { runEffect } from "./helpers/native";
import { describe, expect, test } from "bun:test";
import { Effect, Either } from "effect";
import { APIError, coerceApiError, decodeLlmFailure } from "../src/error";
import { ForeignFailure } from "../src/errors";
import { sdkError } from "./helpers/retry";

describe("provider failure decoder", () => {
  test("passes through a tagged provider failure", () => {
    const error = new APIError({ message: "boom", isRetryable: true });
    expect(coerceApiError(error)).toBe(error);
    expect(Effect.runSync(Effect.either(error))).toEqual(Either.left(error));
  });
  test("decodes SDK fields and lowercases response headers", () => {
    const failure = sdkError({ message: "sdk fixture", isRetryable: true, statusCode: 529, responseHeaders: { "Retry-After-Ms": "1200" }, responseBody: '{"type":"error"}' });
    const coerced = coerceApiError(failure);
    expect(coerced?._tag).toBe("APIError");
    expect(coerced).toMatchObject({ message: "sdk fixture", isRetryable: true, statusCode: 529, responseHeaders: { "retry-after-ms": "1200" }, responseBody: '{"type":"error"}', cause: String(failure) });
  });
  test.each([new Error("plain"), "string error", null, { message: "missing retry flag" }])("declines values without retry metadata: %j", (value) => {
    expect(coerceApiError(value)).toBeUndefined();
  });
  test("all optional provider facts are direct serializable fields", () => {
    const fields = { message: "API request failed", statusCode: 500, isRetryable: true, responseHeaders: { "content-type": "application/json" }, responseBody: '{"error":"internal"}', metadata: { requestID: "req_123" } };
    const error = new APIError(fields);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject(fields);
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({ _tag: "APIError", ...fields });
    expect("data" in error).toBe(false);
  });
  test("minimal fields have no invented provider metadata", () => {
    const error = new APIError({ message: "API error", isRetryable: false });
    expect(error.isRetryable).toBe(false);
    for (const key of ["statusCode", "responseHeaders", "responseBody", "metadata"]) expect(Reflect.has(error, key)).toBe(false);
  });
  test.each([null, false, 42, "diagnostic", { malformed: true }])("unrepresentable failures preserve a string cause: %j", (value) => {
    const error = decodeLlmFailure("provider.decode")(value);
    expect(error).toBeInstanceOf(ForeignFailure);
    expect(error.cause).toBe(String(value));
  });
});

import { describe, it, expect } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { successResult, errorResult, fromError } from "./result.js";

const call: Tool.Call = { id: "call-abc", tool: "test-tool", input: {} };

describe("successResult", () => {
  it("sets toolCallId from the call id", () => {
    const result = successResult(call, "output text");
    expect(result.toolCallId).toBe("call-abc");
  });

  it("sets the output string", () => {
    const result = successResult(call, "hello world");
    expect(result.output).toBe("hello world");
  });

  it("does not set isError", () => {
    const result = successResult(call, "ok");
    expect(result.isError).toBeUndefined();
  });

  it("generates a unique id each call", () => {
    const a = successResult(call, "ok");
    const b = successResult(call, "ok");
    expect(a.id).not.toBe(b.id);
  });

  it("id is a valid UUID", () => {
    const result = successResult(call, "ok");
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("errorResult", () => {
  it("sets toolCallId from the call id", () => {
    const result = errorResult(call, "something failed");
    expect(result.toolCallId).toBe("call-abc");
  });

  it("sets the output string", () => {
    const result = errorResult(call, "something failed");
    expect(result.output).toBe("something failed");
  });

  it("sets isError to true", () => {
    const result = errorResult(call, "err");
    expect(result.isError).toBe(true);
  });

  it("generates a unique id each call", () => {
    const a = errorResult(call, "err");
    const b = errorResult(call, "err");
    expect(a.id).not.toBe(b.id);
  });
});

describe("fromError", () => {
  it("extracts message from an Error instance", () => {
    const result = fromError(call, new Error("disk full"));
    expect(result.output).toBe("disk full");
    expect(result.isError).toBe(true);
  });

  it("converts non-Error to string", () => {
    const result = fromError(call, "raw string error");
    expect(result.output).toBe("raw string error");
    expect(result.isError).toBe(true);
  });

  it("converts number to string", () => {
    const result = fromError(call, 42);
    expect(result.output).toBe("42");
  });

  it("converts null to string", () => {
    const result = fromError(call, null);
    expect(result.output).toBe("null");
  });

  it("converts undefined to string", () => {
    const result = fromError(call, undefined);
    expect(result.output).toBe("undefined");
  });

  it("propagates toolCallId correctly", () => {
    const otherCall: Tool.Call = { id: "call-xyz", tool: "other", input: {} };
    const result = fromError(otherCall, new Error("oops"));
    expect(result.toolCallId).toBe("call-xyz");
  });
});

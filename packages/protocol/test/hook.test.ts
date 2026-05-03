import { describe, expect, test } from "bun:test";
import { Hook } from "../src/hook/index";

describe("Hook.Timing", () => {
  test("parses valid timing values", () => {
    expect(Hook.Timing.parse("pre_tool_use")).toBe("pre_tool_use");
    expect(Hook.Timing.parse("post_turn")).toBe("post_turn");
  });

  test("rejects invalid timing", () => {
    expect(() => Hook.Timing.parse("invalid")).toThrow();
  });
});

describe("Hook.Verdict", () => {
  test("parses continue without metadata", () => {
    expect(Hook.Verdict.parse({ action: "continue" })).toEqual({ action: "continue" });
  });

  test("parses continue with reason and policyId", () => {
    expect(Hook.Verdict.parse({ action: "continue", reason: "ok", policyId: "test" })).toEqual({
      action: "continue",
      reason: "ok",
      policyId: "test",
    });
  });

  test("parses skip with reason", () => {
    expect(Hook.Verdict.parse({ action: "skip", reason: "test" })).toEqual({
      action: "skip",
      reason: "test",
    });
  });

  test("parses skip with reason and policyId", () => {
    expect(
      Hook.Verdict.parse({ action: "skip", reason: "test", policyId: "guardrail.permission" }),
    ).toEqual({
      action: "skip",
      reason: "test",
      policyId: "guardrail.permission",
    });
  });

  test("parses transform with input", () => {
    expect(Hook.Verdict.parse({ action: "transform", input: { key: "val" } })).toEqual({
      action: "transform",
      input: { key: "val" },
    });
  });

  test("parses transform with input, reason, and policyId", () => {
    expect(
      Hook.Verdict.parse({
        action: "transform",
        input: { key: "val" },
        reason: "normalized",
        policyId: "input.transform",
      }),
    ).toEqual({
      action: "transform",
      input: { key: "val" },
      reason: "normalized",
      policyId: "input.transform",
    });
  });

  test("parses inject with message", () => {
    expect(Hook.Verdict.parse({ action: "inject", message: "hello" })).toEqual({
      action: "inject",
      message: "hello",
    });
  });

  test("parses inject with message, reason, and policyId", () => {
    expect(
      Hook.Verdict.parse({
        action: "inject",
        message: "hello",
        reason: "injected",
        policyId: "middleware.inject",
      }),
    ).toEqual({
      action: "inject",
      message: "hello",
      reason: "injected",
      policyId: "middleware.inject",
    });
  });

  test("rejects invalid action", () => {
    expect(() => Hook.Verdict.parse({ action: "invalid" })).toThrow();
  });

  test("parses abort", () => {
    expect(Hook.Verdict.parse({ action: "abort", reason: "stop" })).toEqual({
      action: "abort",
      reason: "stop",
    });
  });

  test("parses abort with policyId", () => {
    expect(
      Hook.Verdict.parse({ action: "abort", reason: "stop", policyId: "guardrail.permission" }),
    ).toEqual({
      action: "abort",
      reason: "stop",
      policyId: "guardrail.permission",
    });
  });

  test("parses retry", () => {
    expect(Hook.Verdict.parse({ action: "retry" })).toEqual({ action: "retry" });
  });

  test("parses retry with reason and policyId", () => {
    expect(
      Hook.Verdict.parse({ action: "retry", reason: "transient", policyId: "retry.policy" }),
    ).toEqual({
      action: "retry",
      reason: "transient",
      policyId: "retry.policy",
    });
  });
});

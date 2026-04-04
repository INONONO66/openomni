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
  test("parses continue", () => {
    expect(Hook.Verdict.parse({ action: "continue" })).toEqual({ action: "continue" });
  });

  test("parses skip with reason", () => {
    expect(Hook.Verdict.parse({ action: "skip", reason: "test" })).toEqual({
      action: "skip",
      reason: "test",
    });
  });

  test("parses transform with input", () => {
    expect(Hook.Verdict.parse({ action: "transform", input: { key: "val" } })).toEqual({
      action: "transform",
      input: { key: "val" },
    });
  });

  test("parses inject with message", () => {
    expect(Hook.Verdict.parse({ action: "inject", message: "hello" })).toEqual({
      action: "inject",
      message: "hello",
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

  test("parses retry", () => {
    expect(Hook.Verdict.parse({ action: "retry" })).toEqual({ action: "retry" });
  });
});

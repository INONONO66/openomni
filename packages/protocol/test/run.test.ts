import { describe, test, expect } from "bun:test";
import { Run } from "../src/run/index.js";

describe("Run.Outcome", () => {
  test("parses stop", () => {
    expect(Run.Outcome.parse({ type: "stop" })).toEqual({ type: "stop" });
  });

  test("parses aborted", () => {
    expect(Run.Outcome.parse({ type: "aborted" })).toEqual({ type: "aborted" });
  });

  test("parses error with message only", () => {
    const outcome = Run.Outcome.parse({
      type: "error",
      error: { message: "boom" },
    }) as Extract<Run.Outcome, { type: "error" }>;

    expect(outcome.error).toEqual({ message: "boom" });
  });

  test("parses error with name and stack", () => {
    const outcome = Run.Outcome.parse({
      type: "error",
      error: {
        message: "boom",
        name: "BoomError",
        stack: "stack trace",
      },
    }) as Extract<Run.Outcome, { type: "error" }>;

    expect(outcome.error).toEqual({
      message: "boom",
      name: "BoomError",
      stack: "stack trace",
    });
  });

  test("rejects error without message", () => {
    expect(() =>
      Run.Outcome.parse({
        type: "error",
        error: {},
      }),
    ).toThrow();
  });

  test("rejects unknown outcome type", () => {
    expect(() => Run.Outcome.parse({ type: "other" })).toThrow();
  });
});

describe("Run.RetryPolicy", () => {
  test("parses a valid retry policy with retryOn", () => {
    const policy = Run.RetryPolicy.parse({
      maxAttempts: 3,
      backoffMs: {
        initial: 100,
        multiplier: 2,
        max: 1000,
      },
      retryOn: ["timeout", "tool_error", "transient_error", "validation_error"],
    });

    expect(policy.retryOn).toEqual([
      "timeout",
      "tool_error",
      "transient_error",
      "validation_error",
    ]);
  });

  test("parses a valid retry policy without retryOn", () => {
    const policy = Run.RetryPolicy.parse({
      maxAttempts: 1,
      backoffMs: {
        initial: 10,
        multiplier: 1.5,
        max: 100,
      },
    });

    expect(policy.retryOn).toBeUndefined();
  });

  test("rejects invalid retryOn values", () => {
    expect(() =>
      Run.RetryPolicy.parse({
        maxAttempts: 3,
        backoffMs: {
          initial: 100,
          multiplier: 2,
          max: 1000,
        },
        retryOn: ["invalid"],
      }),
    ).toThrow();
  });
});

describe("Run.Budget", () => {
  test("accepts negative and fractional numbers", () => {
    const budget = Run.Budget.parse({
      maxWallTimeMs: -1,
      maxTurns: 0,
      maxToolCalls: -100,
      maxToolRuntimeMs: 0.5,
    });

    expect(budget).toEqual({
      maxWallTimeMs: -1,
      maxTurns: 0,
      maxToolCalls: -100,
      maxToolRuntimeMs: 0.5,
    });
  });

  test("parses a normal budget", () => {
    const budget = Run.Budget.parse({
      maxWallTimeMs: 60000,
      maxTurns: 20,
      maxToolCalls: 10,
      maxToolRuntimeMs: 15000,
    });

    expect(budget.maxTurns).toBe(20);
  });
});

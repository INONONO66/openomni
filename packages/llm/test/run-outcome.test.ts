import { describe, expect, test } from "bun:test";
import { Policy } from "@openomni/protocol";
import { Run } from "../src/run";

// #500 C1: moved from packages/protocol/test/run.test.ts (schema suite) and
// packages/protocol/test/policy/input-schema-{parity,isolation}.test.ts (the
// Run.Outcome cases) — the canonical schema lives here now, and protocol
// cannot import llm to keep pinning it from its old home.

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

describe("Run.Outcome vs the run.lifecycle.post policy input schema", () => {
  const embed = (runOutcome: unknown) => ({ sessionId: "session-1", runId: "run-1", runOutcome });
  const policy = Policy.PolicyPoint.InputSchemas["run.lifecycle.post"];

  test("policy duplicate stays in parity for every canonical candidate", () => {
    const candidates: readonly unknown[] = [
      { type: "stop" },
      { type: "continue" },
      { type: "error", error: { message: "failed", name: "Error", stack: "stack" } },
      { type: "invalid" },
      { type: "error" },
      { type: "error", error: {} },
      { type: "error", error: { message: "failed", name: 1 } },
      { type: "stop", extra: true },
    ];
    for (const candidate of candidates) {
      expect(policy.safeParse(embed(candidate)).success).toBe(
        Run.Outcome.safeParse(candidate).success,
      );
    }
  });

  test("max-steps exists only at the agent lifecycle policy boundary", () => {
    expect(policy.safeParse(embed({ type: "max-steps" })).success).toBe(true);
    expect(Run.Outcome.safeParse({ type: "max-steps" }).success).toBe(false);
  });

  test("the policy validator is isolated from mutation of the shared canonical schema", () => {
    const optionsMap = Reflect.get(Run.Outcome, "optionsMap");
    if (!(optionsMap instanceof Map)) throw new Error("Missing run outcome options map");
    const stopOption = optionsMap.get("stop");
    expect(Reflect.apply(Map.prototype.delete, optionsMap, ["stop"])).toBe(true);
    let validStopAccepted = false;
    try {
      validStopAccepted = policy.safeParse(embed({ type: "stop" })).success;
    } finally {
      Reflect.apply(Map.prototype.set, optionsMap, ["stop", stopOption]);
    }
    expect(validStopAccepted).toBe(true);
  });
});

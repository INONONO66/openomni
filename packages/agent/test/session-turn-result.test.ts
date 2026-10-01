import { expect, test } from "bun:test";
import { RunnerOutputMissing } from "../src/errors";
import { runnerOutputMissingResult } from "../src/session-turn";
import { policyRefusalResult, sessionRunnerResultValue } from "../src/session-record";

// Issue #1245 (2): absent runner output is a distinct typed failure, not a
// policy rejection disguised as `invalid_output`.
test("missing runner output is a typed RunnerOutputMissing failure", () => {
  const result = runnerOutputMissingResult("turn-7");
  expect(result.kind).toBe("error");
  if (result.kind !== "error") throw new Error("unreachable");
  expect(result.cause).toBeInstanceOf(RunnerOutputMissing);
  if (!(result.cause instanceof RunnerOutputMissing)) throw new Error("unreachable");
  expect(result.cause._tag).toBe("RunnerOutputMissing");
  expect(result.cause.turnId).toBe("turn-7");
  expect(result.text).toBe("runner output missing: turn turn-7");
});

test("missing runner output is distinguishable from a policy refusal, durably too", () => {
  const missing = runnerOutputMissingResult("turn-7");
  const refusal = policyRefusalResult("invalid_output");
  expect(missing.kind === "error" && missing.cause?._tag).toBe("RunnerOutputMissing");
  expect(refusal.kind === "error" && refusal.cause?._tag).toBe("SessionPolicyRefusal");
  // The durable value keeps the distinct text, so a sealed terminal never
  // reads as "session policy refused" when the runner simply produced nothing.
  expect(sessionRunnerResultValue(missing)).toEqual({ kind: "error", text: "runner output missing: turn turn-7" });
  expect(sessionRunnerResultValue(refusal)).not.toEqual(sessionRunnerResultValue(missing));
});

import { expect, test } from "bun:test";
import {
  DRIVE_BLOCKED_RECURRENCE,
  DRIVE_CONTINUATION_CAP,
  DRIVE_REPETITION_STREAK,
  DRIVE_TOOLLESS_STALL_STREAK,
  decideDrive,
  initialDriveState,
} from "../src/delegation/drive-loop";
import type { DriveDecision, DriveObservation, DriveState } from "../src/delegation/drive-loop";

function drive(observations: readonly DriveObservation[]): DriveDecision {
  let state: DriveState = initialDriveState();
  let decision: DriveDecision = { action: "done" };
  for (const observation of observations) {
    decision = decideDrive(state, observation);
    if (decision.action !== "continue") return decision;
    state = decision.state;
  }
  return decision;
}

const working: DriveObservation = { text: "still working through the checks", finishReason: "max-steps" };
const stalled = (text: string): DriveObservation => ({ text, finishReason: "stalled" });
const blocked = (text: string): DriveObservation => ({ text, finishReason: "stop" });

test("a natural stop is done — the drive loop never nannies a finished run", () => {
  expect(drive([{ text: "all criteria hold; evidence attached", finishReason: "stop" }])).toEqual({
    action: "done",
  });
});

test("an exhausted step budget is live work: the loop continues with streaks reset", () => {
  const first = decideDrive(initialDriveState(), stalled("hm"));
  expect(first.action).toBe("continue");
  const second = decideDrive(first.action === "continue" ? first.state : initialDriveState(), working);
  expect(second.action).toBe("continue");
  if (second.action === "continue") {
    expect(second.state.stallStreak).toBe(0);
    expect(second.state.blockedStreak).toBe(0);
  }
});

test("three consecutive stalls stop the loop as a toolless stall", () => {
  const observations = Array.from({ length: DRIVE_TOOLLESS_STALL_STREAK }, (_, i) => stalled(`stall ${i}`));
  expect(drive(observations)).toEqual({ action: "stop", reason: "toolless_stall" });
  expect(drive(observations.slice(0, DRIVE_TOOLLESS_STALL_STREAK - 1)).action).toBe("continue");
});

test("identical continued output three times running stops the loop as repetition", () => {
  const observations = Array.from({ length: DRIVE_REPETITION_STREAK }, () => working);
  expect(drive(observations)).toEqual({ action: "stop", reason: "repetition" });
});

test("a blocked claim needs three recurrences before the loop believes it", () => {
  const claims = Array.from({ length: DRIVE_BLOCKED_RECURRENCE }, (_, i) => blocked(`BLOCKED: gate ${i} is closed`));
  expect(drive(claims)).toEqual({ action: "stop", reason: "blocked" });
  const early = drive(claims.slice(0, DRIVE_BLOCKED_RECURRENCE - 1));
  expect(early.action).toBe("continue");
  if (early.action === "continue") expect(early.prompt).toContain("BLOCKED");
});

test("real progress resets a blocked streak", () => {
  const outcome = drive([blocked("BLOCKED: a"), working, blocked("BLOCKED: b"), working, blocked("BLOCKED: c")]);
  expect(outcome.action).toBe("continue");
});

test("the continuation cap bounds the loop at eight runs total", () => {
  const observations = Array.from({ length: DRIVE_CONTINUATION_CAP }, (_, i) =>
    i % 2 === 0 ? working : stalled(`s${i}`),
  );
  expect(drive(observations)).toEqual({ action: "stop", reason: "continuation_cap" });
});

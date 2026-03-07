import { describe, expect, it } from "bun:test";
import type { PlanStep } from "@openomni/protocol";
import { RunLedger } from "../../src/team/run-ledger";

function makeSteps(ids: string[]): PlanStep[] {
  return ids.map((stepId) => ({
    stepId,
    description: `Step ${stepId}`,
    expectedOutput: `Output of ${stepId}`,
    dependsOn: [],
  }));
}

describe("RunLedger", () => {
  it("initializes all steps as ready with zero counters", () => {
    const ledger = RunLedger.create(makeSteps(["s1", "s2", "s3"]));
    const state = ledger.getState();

    expect(state.size).toBe(3);
    for (const [, entry] of state) {
      expect(entry.state).toBe("ready");
      expect(entry.attempts).toBe(0);
      expect(entry.rejectionStreak).toBe(0);
      expect(entry.totalRejections).toBe(0);
      expect(entry.startedAt).toBeUndefined();
      expect(entry.completedAt).toBeUndefined();
    }
  });

  it("transitions from ready to running", () => {
    const ledger = RunLedger.create(makeSteps(["step-1"]));
    ledger.transition("step-1", "running");

    const entry = ledger.getStepState("step-1")!;
    expect(entry.state).toBe("running");
    expect(entry.startedAt).toBeInstanceOf(Date);
  });

  it("transitions from running to succeeded with completedAt", () => {
    const ledger = RunLedger.create(makeSteps(["step-1"]));
    ledger.transition("step-1", "running");
    ledger.transition("step-1", "succeeded");

    const entry = ledger.getStepState("step-1")!;
    expect(entry.state).toBe("succeeded");
    expect(entry.completedAt).toBeInstanceOf(Date);
  });

  it("throws when transitioning ready → succeeded (must run first)", () => {
    const ledger = RunLedger.create(makeSteps(["step-2"]));
    expect(() => ledger.transition("step-2", "succeeded")).toThrow(
      /invalid.*transition/i,
    );
  });

  it("throws when transitioning succeeded → running", () => {
    const ledger = RunLedger.create(makeSteps(["step-1"]));
    ledger.transition("step-1", "running");
    ledger.transition("step-1", "succeeded");

    expect(() => ledger.transition("step-1", "running")).toThrow(
      /invalid.*transition/i,
    );
  });

  it("increments attempts on recordAttempt", () => {
    const ledger = RunLedger.create(makeSteps(["step-1"]));

    ledger.recordAttempt("step-1");
    expect(ledger.getStepState("step-1")!.attempts).toBe(1);

    ledger.recordAttempt("step-1");
    expect(ledger.getStepState("step-1")!.attempts).toBe(2);
  });

  it("increments rejectionStreak and totalRejections on recordRejection", () => {
    const ledger = RunLedger.create(makeSteps(["step-1"]));

    ledger.recordRejection("step-1");
    const entry1 = ledger.getStepState("step-1")!;
    expect(entry1.rejectionStreak).toBe(1);
    expect(entry1.totalRejections).toBe(1);

    ledger.recordRejection("step-1");
    const entry2 = ledger.getStepState("step-1")!;
    expect(entry2.rejectionStreak).toBe(2);
    expect(entry2.totalRejections).toBe(2);
  });

  it("resets rejectionStreak without affecting totalRejections", () => {
    const ledger = RunLedger.create(makeSteps(["step-1"]));

    ledger.recordRejection("step-1");
    ledger.recordRejection("step-1");
    ledger.recordRejection("step-1");
    ledger.resetRejectionStreak("step-1");

    const entry = ledger.getStepState("step-1")!;
    expect(entry.rejectionStreak).toBe(0);
    expect(entry.totalRejections).toBe(3);
  });

  it("returns a deep copy from getState that does not affect internal state", () => {
    const ledger = RunLedger.create(makeSteps(["step-1"]));
    const copy = ledger.getState();

    copy.delete("step-1");
    expect(copy.size).toBe(0);

    const fresh = ledger.getState();
    expect(fresh.size).toBe(1);
    expect(fresh.get("step-1")!.state).toBe("ready");
  });

  it("returns deep-copied entries that cannot mutate internal state", () => {
    const ledger = RunLedger.create(makeSteps(["step-1"]));
    const copy = ledger.getState();
    const entry = copy.get("step-1")!;

    (entry as any).attempts = 999;

    expect(ledger.getStepState("step-1")!.attempts).toBe(0);
  });

  it("getRunning returns only running steps", () => {
    const ledger = RunLedger.create(makeSteps(["s1", "s2", "s3"]));
    ledger.transition("s1", "running");
    ledger.transition("s2", "running");

    const running = ledger.getRunning();
    expect(running).toHaveLength(2);
    expect(running.map((e) => e.stepId).sort()).toEqual(["s1", "s2"]);
  });

  it("getCompleted returns succeeded, failed, and skipped steps", () => {
    const ledger = RunLedger.create(makeSteps(["s1", "s2", "s3", "s4"]));

    ledger.transition("s1", "running");
    ledger.transition("s1", "succeeded");

    ledger.transition("s2", "running");
    ledger.transition("s2", "failed");

    ledger.transition("s3", "skipped");

    const completed = ledger.getCompleted();
    expect(completed).toHaveLength(3);
    expect(completed.map((e) => e.stepId).sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("throws step not found for non-existent step", () => {
    const ledger = RunLedger.create(makeSteps(["s1"]));
    expect(() => ledger.transition("nope", "running")).toThrow(
      /step not found/i,
    );
  });

  it("allows transition to skipped from any state", () => {
    const steps = makeSteps([
      "ready-s",
      "running-s",
      "succeeded-s",
      "failed-s",
    ]);
    const ledger = RunLedger.create(steps);

    ledger.transition("running-s", "running");
    ledger.transition("succeeded-s", "running");
    ledger.transition("succeeded-s", "succeeded");
    ledger.transition("failed-s", "running");
    ledger.transition("failed-s", "failed");

    ledger.transition("ready-s", "skipped");
    ledger.transition("running-s", "skipped");
    ledger.transition("succeeded-s", "skipped");
    ledger.transition("failed-s", "skipped");

    for (const id of ["ready-s", "running-s", "succeeded-s", "failed-s"]) {
      expect(ledger.getStepState(id)!.state).toBe("skipped");
    }
  });

  it("transitions from running to failed", () => {
    const ledger = RunLedger.create(makeSteps(["step-1"]));
    ledger.transition("step-1", "running");
    ledger.transition("step-1", "failed");

    const entry = ledger.getStepState("step-1")!;
    expect(entry.state).toBe("failed");
    expect(entry.completedAt).toBeInstanceOf(Date);
  });

  it("throws when transitioning failed → running", () => {
    const ledger = RunLedger.create(makeSteps(["step-1"]));
    ledger.transition("step-1", "running");
    ledger.transition("step-1", "failed");

    expect(() => ledger.transition("step-1", "running")).toThrow(
      /invalid.*transition/i,
    );
  });

  it("getStepState returns undefined for unknown step", () => {
    const ledger = RunLedger.create(makeSteps(["s1"]));
    expect(ledger.getStepState("nope")).toBeUndefined();
  });

  it("throws on recordAttempt for unknown step", () => {
    const ledger = RunLedger.create(makeSteps(["s1"]));
    expect(() => ledger.recordAttempt("nope")).toThrow(/step not found/i);
  });

  it("throws on recordRejection for unknown step", () => {
    const ledger = RunLedger.create(makeSteps(["s1"]));
    expect(() => ledger.recordRejection("nope")).toThrow(/step not found/i);
  });

  it("throws on resetRejectionStreak for unknown step", () => {
    const ledger = RunLedger.create(makeSteps(["s1"]));
    expect(() => ledger.resetRejectionStreak("nope")).toThrow(
      /step not found/i,
    );
  });
});

import { describe, expect, it } from "bun:test";
import type { PlanStep } from "@openomni/protocol";
import { RunLedger } from "../../src/team/run-ledger";
import { DAG } from "../../src/dag/index";
import { StallDetector } from "../../src/team/stall-detector";

function makeStep(id: string, deps: string[] = []): PlanStep {
  return {
    stepId: id,
    description: `Step ${id}`,
    expectedOutput: `Output of ${id}`,
    dependsOn: deps,
  };
}

const DEFAULT_CONFIG: StallDetector.StallConfig = {
  maxConsecutiveRejections: 3,
  maxNoProgressTurns: 5,
};

describe("StallDetector", () => {
  describe("checkConsecutiveRejections", () => {
    it("detects stall when rejectionStreak >= max", () => {
      const steps = [makeStep("A")];
      const ledger = RunLedger.create(steps);

      ledger.transition("A", "running");
      ledger.recordRejection("A");
      ledger.recordRejection("A");
      ledger.recordRejection("A");

      const result = StallDetector.checkConsecutiveRejections(
        ledger,
        DEFAULT_CONFIG,
      );
      expect(result.stalled).toBe(true);
      expect(result.reason).toBe("consecutive_rejections");
      expect(result.stalledStepId).toBe("A");
    });

    it("returns no stall when rejectionStreak < max", () => {
      const steps = [makeStep("A")];
      const ledger = RunLedger.create(steps);

      ledger.transition("A", "running");
      ledger.recordRejection("A");
      ledger.recordRejection("A");

      const result = StallDetector.checkConsecutiveRejections(
        ledger,
        DEFAULT_CONFIG,
      );
      expect(result.stalled).toBe(false);
    });
  });

    it("ignores terminal (failed/succeeded/skipped) steps when checking rejections", () => {
      const steps = [makeStep("A"), makeStep("B")];
      const ledger = RunLedger.create(steps);

      // Step A: failed with high rejection streak
      ledger.transition("A", "running");
      ledger.recordRejection("A");
      ledger.recordRejection("A");
      ledger.recordRejection("A");
      ledger.transition("A", "failed");

      // Step B: running with no rejections
      ledger.transition("B", "running");

      // Should NOT detect stall — A is terminal and should be filtered
      const result = StallDetector.checkConsecutiveRejections(
        ledger,
        DEFAULT_CONFIG,
      );
      expect(result.stalled).toBe(false);
    });

  describe("checkNoProgress", () => {
    it("detects stall when noProgressTurns >= max and no running steps", () => {
      const steps = [makeStep("A"), makeStep("B")];
      const ledger = RunLedger.create(steps);
      const dag = DAG.build(steps);


      const result = StallDetector.checkNoProgress(
        ledger,
        dag,
        DEFAULT_CONFIG,
        5,
      );
      expect(result.stalled).toBe(true);
      expect(result.reason).toBe("no_progress");
    });

    it("returns no stall when noProgressTurns >= max but steps are running", () => {
      const steps = [makeStep("A"), makeStep("B")];
      const ledger = RunLedger.create(steps);
      const dag = DAG.build(steps);

      ledger.transition("A", "running");

      const result = StallDetector.checkNoProgress(
        ledger,
        dag,
        DEFAULT_CONFIG,
        5,
      );
      expect(result.stalled).toBe(false);
    });

    it("returns no stall when noProgressTurns < max", () => {
      const steps = [makeStep("A"), makeStep("B")];
      const ledger = RunLedger.create(steps);
      const dag = DAG.build(steps);

      const result = StallDetector.checkNoProgress(
        ledger,
        dag,
        DEFAULT_CONFIG,
        3,
      );
      expect(result.stalled).toBe(false);
    });
  });

  describe("checkUnsatisfiableDeps", () => {
    it("detects stall when all deps are failed/skipped", () => {
      const steps = [makeStep("A"), makeStep("B", ["A"])];
      const ledger = RunLedger.create(steps);
      const dag = DAG.build(steps);

      ledger.transition("A", "running");
      ledger.transition("A", "failed");

      const result = StallDetector.checkUnsatisfiableDeps(ledger, dag);
      expect(result.stalled).toBe(true);
      expect(result.reason).toBe("unsatisfiable_deps");
      expect(result.stalledStepId).toBe("B");
    });

    it("returns no stall when step has no deps", () => {
      const steps = [makeStep("A"), makeStep("B")];
      const ledger = RunLedger.create(steps);
      const dag = DAG.build(steps);

      const result = StallDetector.checkUnsatisfiableDeps(ledger, dag);
      expect(result.stalled).toBe(false);
    });

    it("detects stall when some deps succeeded and some failed", () => {
      const steps = [makeStep("A"), makeStep("B"), makeStep("C", ["A", "B"])];
      const ledger = RunLedger.create(steps);
      const dag = DAG.build(steps);

      ledger.transition("A", "running");
      ledger.transition("A", "succeeded");
      ledger.transition("B", "running");
      ledger.transition("B", "failed");

      const result = StallDetector.checkUnsatisfiableDeps(ledger, dag);
      expect(result.stalled).toBe(true);
      expect(result.reason).toBe("unsatisfiable_deps");
      expect(result.stalledStepId).toBe("C");
    });
  });

  describe("check", () => {
    it("returns no stall when all steps running normally", () => {
      const steps = [makeStep("A"), makeStep("B")];
      const ledger = RunLedger.create(steps);
      const dag = DAG.build(steps);

      ledger.transition("A", "running");
      ledger.transition("B", "running");

      const result = StallDetector.check(ledger, dag, DEFAULT_CONFIG, 0);
      expect(result.stalled).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it("consecutive_rejections takes priority over no_progress", () => {
      const steps = [makeStep("A"), makeStep("B")];
      const ledger = RunLedger.create(steps);
      const dag = DAG.build(steps);

      // Step A is running with 3 rejections (not terminal)
      ledger.transition("A", "running");
      ledger.recordRejection("A");
      ledger.recordRejection("A");
      ledger.recordRejection("A");
      const result = StallDetector.check(ledger, dag, DEFAULT_CONFIG, 5);
      expect(result.stalled).toBe(true);
      expect(result.reason).toBe("consecutive_rejections");
    });

    it("returns no stall when everything is fine", () => {
      const steps = [makeStep("A"), makeStep("B", ["A"])];
      const ledger = RunLedger.create(steps);
      const dag = DAG.build(steps);

      ledger.transition("A", "running");

      const result = StallDetector.check(ledger, dag, DEFAULT_CONFIG, 0);
      expect(result.stalled).toBe(false);
    });
  });
});

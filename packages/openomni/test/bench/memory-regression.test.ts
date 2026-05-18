import { describe, expect, test } from "bun:test";
import { DAG, type DAGStep } from "../../src/dag/index.ts";

function measureRSS(): number {
  Bun.gc(true);
  return process.memoryUsage().rss;
}

function createSteps(): DAGStep[] {
  return Array.from({ length: 50 }, (_, index) => ({
    stepId: `step-${index}`,
    dependsOn: index === 0 ? [] : [`step-${index - 1}`],
  }));
}

describe("openomni memory regression", () => {
  test("DAG build/validate does not leak", () => {
    const steps = createSteps();
    for (let index = 0; index < 1000; index += 1) {
      const dag = DAG.build(steps);
      const result = DAG.validateAcyclic(dag);
      if (!result.valid) throw new Error(`unexpected cycle: ${result.cycle.join(" -> ")}`);
    }

    const baseline = measureRSS();

    for (let index = 0; index < 1000; index += 1) {
      const dag = DAG.build(steps);
      const result = DAG.validateAcyclic(dag);
      if (!result.valid) throw new Error(`unexpected cycle: ${result.cycle.join(" -> ")}`);
    }

    const final = measureRSS();
    const growthMB = (final - baseline) / 1024 / 1024;
    expect(growthMB).toBeLessThan(5);
  }, 30_000);

  test("Map/Set task lifecycle operations do not leak", () => {
    for (let index = 0; index < 1000; index += 1) {
      const tasks = new Map<string, { readonly status: string; readonly depth: number }>();
      const active = new Set<string>();
      for (let taskIndex = 0; taskIndex < 50; taskIndex += 1) {
        const taskId = `warmup-${index}-${taskIndex}`;
        tasks.set(taskId, { status: "running", depth: taskIndex % 4 });
        active.add(taskId);
      }
      for (const taskId of active) {
        active.delete(taskId);
        tasks.delete(taskId);
      }
    }

    const baseline = measureRSS();

    for (let index = 0; index < 1000; index += 1) {
      const tasks = new Map<string, { readonly status: string; readonly depth: number }>();
      const active = new Set<string>();
      for (let taskIndex = 0; taskIndex < 50; taskIndex += 1) {
        const taskId = `task-${index}-${taskIndex}`;
        tasks.set(taskId, { status: "running", depth: taskIndex % 4 });
        active.add(taskId);
      }

      for (const taskId of active) {
        const task = tasks.get(taskId);
        if (task?.status === "running") {
          tasks.set(taskId, { ...task, status: "succeeded" });
        }
      }

      for (const taskId of active) {
        active.delete(taskId);
        tasks.delete(taskId);
      }
    }

    const final = measureRSS();
    const growthMB = (final - baseline) / 1024 / 1024;
    expect(growthMB).toBeLessThan(5);
  }, 30_000);
});

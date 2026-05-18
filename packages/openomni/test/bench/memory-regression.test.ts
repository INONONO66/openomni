import { describe, expect, test } from "bun:test";

function measureRSS(): number {
  Bun.gc(true);
  return process.memoryUsage().rss;
}

describe("openomni memory regression", () => {
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
    expect(growthMB).toBeLessThan(15);
  }, 30_000);
});

// Run with: bun run bench/index.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { Bench } from "tinybench";

interface BenchmarkResult {
  readonly name: string;
  readonly unit: "ns/op";
  readonly value: number;
}

interface PendingTask {
  readonly id: string;
  readonly priority: number;
  readonly status: "pending";
}

const bench = new Bench({
  name: "Background Queue Operations",
  time: 100,
  warmupTime: 20,
});

for (const size of [10, 50, 100]) {
  const tasks = buildPendingTasks(size);

  bench.add(
    `background-queue/${size}-tasks/map-cycle`,
    () => {
      const active = new Map<string, PendingTask>();
      for (const task of tasks) {
        active.set(task.id, task);
        active.get(task.id);
      }
      for (const task of tasks) {
        active.delete(task.id);
      }
    },
    { async: false },
  );

  bench.add(
    `background-queue/${size}-tasks/find-splice`,
    () => {
      const queue = tasks.slice();
      while (queue.length > 0) {
        const index = queue.findIndex((task) => task.priority <= 1);
        queue.splice(index === -1 ? 0 : index, 1);
      }
    },
    { async: false },
  );
}

await bench.run();
console.table(bench.table());

const results = bench.tasks.map((task): BenchmarkResult => {
  const result = task.result;
  if (!result || !("latency" in result)) {
    throw new Error(`Benchmark did not complete: ${task.name}`);
  }

  return {
    name: task.name,
    unit: "ns/op",
    value: result.latency.mean * 1_000_000,
  };
});

mkdirSync("bench-results", { recursive: true });
writeFileSync("bench-results/openomni.json", `${JSON.stringify(results, null, 2)}\n`);

function buildPendingTasks(count: number): PendingTask[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`,
    priority: index % 3,
    status: "pending",
  }));
}

// Run with: bun run bench/index.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { Bench } from "tinybench";
import { DAG, type DAGStep, type DAGStructure } from "../src/dag/index.ts";

interface BenchmarkResult {
  readonly name: string;
  readonly unit: "ns/op";
  readonly value: number;
}

interface DAGFixture {
  readonly name: string;
  readonly steps: DAGStep[];
  readonly dag: DAGStructure;
  readonly completed: Set<string>;
  readonly completeStepId: string;
}

interface PendingTask {
  readonly id: string;
  readonly priority: number;
  readonly status: "pending";
}

const bench = new Bench({
  name: "DAG Operations and Background Queue Operations",
  time: 100,
  warmupTime: 20,
});

const fixtures: DAGFixture[] = [
  buildFixture(
    "dag/10-linear",
    buildLinearSteps(10),
    new Set(["step-0", "step-1", "step-2"]),
    "step-3",
  ),
  buildFixture("dag/50-diamond", buildDiamondSteps(50), new Set(["step-0"]), "step-1"),
  buildFixture(
    "dag/100-mixed",
    buildMixedSteps(100),
    new Set(["step-0", "step-1", "step-2", "step-3", "step-4"]),
    "step-5",
  ),
];

for (const fixture of fixtures) {
  bench.add(
    `${fixture.name}/build`,
    () => {
      DAG.build(fixture.steps);
    },
    { async: false },
  );

  bench.add(
    `${fixture.name}/validate-acyclic`,
    () => {
      DAG.validateAcyclic(fixture.dag);
    },
    { async: false },
  );

  bench.add(
    `${fixture.name}/get-ready`,
    () => {
      DAG.getReady(fixture.dag, fixture.completed);
    },
    { async: false },
  );

  bench.add(
    `${fixture.name}/complete`,
    () => {
      DAG.complete(fixture.dag, fixture.completeStepId, fixture.completed);
    },
    { async: false },
  );
}

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

function buildFixture(
  name: string,
  steps: DAGStep[],
  completed: Set<string>,
  completeStepId: string,
): DAGFixture {
  return {
    name,
    steps,
    dag: DAG.build(steps),
    completed,
    completeStepId,
  };
}

function buildLinearSteps(count: number): DAGStep[] {
  return Array.from({ length: count }, (_, index) => ({
    stepId: `step-${index}`,
    dependsOn: index === 0 ? [] : [`step-${index - 1}`],
  }));
}

function buildDiamondSteps(count: number): DAGStep[] {
  const steps: DAGStep[] = [{ stepId: "step-0", dependsOn: [] }];

  for (let index = 1; index < count - 1; index += 1) {
    const layerStart = Math.max(0, index - 4);
    const dependsOn = index <= 4 ? ["step-0"] : [`step-${layerStart}`, `step-${layerStart + 1}`];
    steps.push({ stepId: `step-${index}`, dependsOn });
  }

  steps.push({
    stepId: `step-${count - 1}`,
    dependsOn: [`step-${count - 3}`, `step-${count - 2}`],
  });

  return steps;
}

function buildMixedSteps(count: number): DAGStep[] {
  return Array.from({ length: count }, (_, index) => {
    if (index === 0) {
      return { stepId: "step-0", dependsOn: [] };
    }

    if (index % 5 === 0) {
      return { stepId: `step-${index}`, dependsOn: [`step-${index - 1}`, `step-${index - 3}`] };
    }

    if (index % 3 === 0) {
      return { stepId: `step-${index}`, dependsOn: [`step-${index - 2}`] };
    }

    return { stepId: `step-${index}`, dependsOn: [`step-${index - 1}`] };
  });
}

function buildPendingTasks(count: number): PendingTask[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`,
    priority: index % 3,
    status: "pending",
  }));
}

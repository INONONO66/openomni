// Run with: bun run bench/index.ts
// Semantic correction: the old PendingTask map/splice loops were bench-only fixtures with no
// production callsites under packages/openomni/src. This suite intentionally breaks gh-pages
// history for that synthetic benchmark and now measures the shipped InjectionQueue and
// effect-scope resolver hotpaths with deterministic fixtures outside timed callbacks at 10/50/100 scale.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "@openomni/session";
import { Bench } from "tinybench";
import { InjectionQueue, createWorkspaceIdentity } from "../src/execution-runtime/index.ts";
import { EffectScopeRegistry, resolveToolEffect } from "../src/execution-runtime/effect-scope.ts";

interface BenchmarkResult {
  readonly name: string;
  readonly unit: "ns/op";
  readonly value: number;
}

interface QueueFixture {
  readonly size: number;
  readonly entries: ReadonlyArray<{
    readonly runId: string;
    readonly response: {
      readonly messageId: string;
      readonly output: string;
      readonly timestamp: number;
    };
  }>;
  readonly runIds: readonly string[];
}

interface EffectScopeFixture {
  readonly size: number;
  readonly writeInputs: ReadonlyArray<{ readonly path: string }>;
  readonly bashInputs: ReadonlyArray<{ readonly command: string }>;
}

const bench = new Bench({
  name: "OpenOmni Runtime Operations",
  time: 100,
  warmupTime: 20,
});

const queueFixtures = [10, 50, 100].map(createQueueFixture);
const effectFixture = createEffectScopeWorkspace();
const effectRegistry = new EffectScopeRegistry();
const effectFixtures = [10, 50, 100].map(createEffectScopeFixture);

for (const fixture of queueFixtures) {
  bench.add(
    `injection-queue/${fixture.size}-responses/enqueue-drain-single-run`,
    () => {
      const queue = InjectionQueue.create();
      for (const entry of fixture.entries) {
        queue.enqueue(entry.runId, entry.response);
      }

      let drained = 0;
      for (const runId of fixture.runIds) {
        if (!queue.hasPending(runId)) {
          throw new Error(`Expected pending queue for ${runId}`);
        }
        drained += queue.drain(runId).length;
        queue.dispose(runId);
      }

      if (drained !== fixture.entries.length) {
        throw new Error(
          `Expected ${fixture.entries.length} drained responses, received ${drained}`,
        );
      }

      return drained;
    },
    { async: false },
  );
}

for (const fixture of effectFixtures) {
  bench.add(
    `effect-scope/${fixture.size}-writes/resolve-tool-effect`,
    () => {
      let resolved = 0;
      for (const input of fixture.writeInputs) {
        const scope = resolveToolEffect(effectRegistry, "write", input, effectFixture.workspace);
        if (!scope) throw new Error("Expected filesystem scope");
        resolved += scope.scope.resources.length;
      }
      return resolved;
    },
    { async: false },
  );

  bench.add(
    `effect-scope/${fixture.size}-bash/resolve-tool-effect`,
    () => {
      let resolved = 0;
      for (const input of fixture.bashInputs) {
        const scope = resolveToolEffect(effectRegistry, "bash", input, effectFixture.workspace);
        if (!scope) throw new Error("Expected bash scope");
        resolved += scope.scope.resources.length;
      }
      return resolved;
    },
    { async: false },
  );
}

try {
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
} finally {
  Bus.reset();
  rmSync(effectFixture.root, { recursive: true, force: true });
}

function createQueueFixture(size: number): QueueFixture {
  const runId = `run-${size}`;
  return {
    size,
    runIds: [runId],
    entries: Array.from({ length: size }, (_, index) => ({
      runId,
      response: {
        messageId: `message-${size}-${index}`,
        output: `queued response ${size}/${index}`,
        timestamp: index,
      },
    })),
  };
}

function createEffectScopeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "openomni-bench-workspace-"));
  const existing = join(root, "existing");
  const alias = join(root, "alias");
  mkdirSync(existing);
  for (let index = 0; index < 100; index += 1) {
    writeFileSync(join(existing, `existing-${index}.json`), `{"index":${index}}\n`);
  }
  symlinkSync(existing, alias, "dir");
  return {
    root,
    workspace: createWorkspaceIdentity(root),
  };
}

function createEffectScopeFixture(size: number): EffectScopeFixture {
  return {
    size,
    writeInputs: Array.from({ length: size }, (_, index) => ({
      path: `alias/generated-${size}-${index}.json`,
    })),
    bashInputs: Array.from({ length: size }, (_, index) => ({
      command: `printf 'bench-%d' ${size + index}`,
    })),
  };
}

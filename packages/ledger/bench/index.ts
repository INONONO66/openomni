// Run with: bun run bench/index.ts
import { Effect, Either } from "effect";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Bench } from "tinybench";
import { L0Observation, type LedgerSession, type Message } from "@openomni/protocol";
import { Bus } from "../test/helpers/observation";
import { materializeSession } from "../test/helpers/session";
import { SessionHandleStore, Storage } from "../src/index";
import { prepareTurnCommit, seedTurnHistory } from "./seed-turn-history";

type BenchmarkResult = {
  readonly name: string;
  readonly unit: "ns/op";
  readonly value: number;
};
const results: BenchmarkResult[] = [];

// One measurement budget for every suite. The published run measures each task
// for 100 ms after tinybench's default warm-up; BENCHMARK_BUDGET_MS shrinks both
// phases to that many milliseconds and one iteration so an emission check of the
// entry point spends its time seeding, not sampling.
const budget = Number(process.env.BENCHMARK_BUDGET_MS);
const measurement = Number.isFinite(budget)
  ? { time: budget, iterations: 1, warmupTime: budget, warmupIterations: 1 }
  : { time: 100 };

function recordResults(suite: string, bench: Bench): void {
  console.log(`\n${suite}`);
  console.table(bench.table());
  for (const task of bench.tasks) {
    const result = task.result;
    if (result.state !== "completed")
      throw new Error(`Benchmark failed: ${suite}/${task.name}`, { cause: result });
    results.push({
      name: `${suite}/${task.name}`,
      unit: "ns/op",
      value: Math.round(result.latency.mean * 1_000_000),
    });
  }
}

async function runSessionHydration(): Promise<void> {
  Storage.initialize({ dbPath: ":memory:" });
  try {
    const sessions = Array.from({ length: 100 }, (_, index) => {
      const id = `bench-session-${index}`;
      seedTurnHistory(id);
      return id;
    });
    const bench = new Bench(measurement);
    let cursor = 0;
    bench.add("get-session", () => {
      SessionHandleStore.row(sessions[cursor++ % sessions.length] ?? "");
    });
    // Keep the historical metric key; the live reader now folds canonical turns.
    bench.add("get-messages", () => {
      SessionHandleStore.getSnapshot(sessions[cursor++ % sessions.length] ?? "", 10).turns.flatMap(
        (turn) => turn.messages,
      );
    });
    await bench.run();
    recordResults("session-hydration", bench);
  } finally {
    Storage.reset();
  }
}

async function runBusFanout(): Promise<void> {
  for (const count of [10, 50, 100]) {
    const bench = new Bench(measurement);
    let handled = 0;
    try {
      for (let index = 0; index < count; index += 1) {
        Bus.subscribe(L0Observation.ActionCommittedEvent, () => {
          handled += 1;
        });
      }
      bench.add(`${count}-subscribers`, async () => {
        const before = handled;
        Bus.publish(L0Observation.ActionCommittedEvent, {
          id: "fanout-configure",
          sessionId: "fanout",
          kind: "session.configure",
          revision: 1,
        });
        // Bus dispatches the complete subscriber batch in its queued microtask.
        await Promise.resolve();
        if (handled - before !== count) throw new Error("incomplete benchmark fanout");
      });
      await bench.run();
      recordResults("bus-fanout", bench);
    } finally {
      Bus.reset();
    }
  }
}

async function runMessageSerialization(): Promise<void> {
  const message: Message.Info = {
    id: "assistant-serialization-session-1",
    sessionID: "serialization-session",
    role: "assistant",
    time: { created: 1_700_000_000_001, completed: 1_700_000_000_051 },
    parentID: "message-serialization-session-1",
    modelID: "bench",
    providerID: "bench",
    agent: "bench-agent",
    path: { cwd: "/tmp/openomni", root: "/tmp/openomni" },
    cost: 0.00042,
    tokens: { input: 512, output: 128, reasoning: 64, cache: { read: 32, write: 16 } },
    finish: "stop",
  };
  const payload = JSON.stringify(message);
  const bench = new Bench(measurement);
  bench.add("stringify-message", () => {
    JSON.stringify(message);
  });
  bench.add("parse-message", () => {
    JSON.parse(payload);
  });
  await bench.run();
  recordResults("message-serialization", bench);
}

async function runStorageSessionList(): Promise<void> {
  // Each measured task completes before its owned adapter is closed.
  for (const count of [10, 100, 500]) {
    Storage.initialize({ dbPath: ":memory:" });
    try {
      for (let index = 0; index < count; index += 1) materializeSession(`list-${count}-${index}`);
      const bench = new Bench(measurement);
      bench.add(`${count}-sessions`, () => {
        SessionHandleStore.listRows();
      });
      await bench.run();
      recordResults("storage-session-list", bench);
    } finally {
      Storage.reset();
    }
  }
}

async function runSessionTree(): Promise<void> {
  Storage.initialize({ dbPath: ":memory:" });
  try {
    const bench = new Bench({ iterations: 5, warmupTime: 100, warmupIterations: 2, ...measurement });
    for (const count of [1_000, 10_000]) {
      const id = `tree-${count}`;
      seedTurnHistory(id, count / 2);
      bench.add(`${count / 1_000}k-actions`, () => {
        SessionHandleStore.tree(id);
      });
    }
    await bench.run();
    recordResults("session-tree", bench);
    const history = new Bench(measurement);
    history.add("page", () => {
      SessionHandleStore.historyPage("tree-10000", { limit: 50 });
    });
    await history.run();
    recordResults("session-history", history);
  } finally {
    Storage.reset();
  }
}

async function runSessionCommit(): Promise<void> {
  Storage.initialize({ dbPath: ":memory:" });
  try {
    const id = "commit-session";
    seedTurnHistory(id);
    const tree = SessionHandleStore.tree(id);
    const generation = SessionHandleStore.latestGeneration(tree);
    let parentId = tree.at(-1)?.id ?? null;
    let index = 10;
    let request: LedgerSession.Commit;
    let result: Effect.Effect.Success<ReturnType<typeof SessionHandleStore.commit>>;
    const bench = new Bench(measurement);
    bench.add(
      "action",
      () => {
        result = Either.getOrThrowWith(Effect.runSync(Effect.either(SessionHandleStore.commit(request))), (error) => error);
      },
      {
        beforeEach() {
          request = prepareTurnCommit(id, index++, parentId, generation);
          request.actions = request.actions.slice(0, 1);
        },
        afterEach() {
          if (!result.ok) throw new Error("benchmark action commit refused", { cause: result });
          parentId = request.actions[0]?.id ?? null;
        },
      },
    );
    await bench.run();
    recordResults("session-commit", bench);
  } finally {
    Storage.reset();
  }
}

try {
  await runSessionHydration();
  await runBusFanout();
  await runMessageSerialization();
  await runStorageSessionList();
  await runSessionTree();
  await runSessionCommit();
  mkdirSync("bench-results", { recursive: true });
  await Bun.write(join("bench-results", "session.json"), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  Storage.reset();
  Bus.reset();
}

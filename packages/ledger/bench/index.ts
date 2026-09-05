// Run with: bun run bench/index.ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Bench } from "tinybench";
import { L0Observation, type Message } from "@openomni/protocol";
import { Bus } from "../test/helpers/observation";
import { materializeSession } from "../test/helpers/session";
import { SessionHandleStore, Storage } from "../src/index";
import { sessionHistory } from "./session-history";

type BenchmarkResult = {
  readonly name: string;
  readonly unit: "ns/op";
  readonly value: number;
};
const results: BenchmarkResult[] = [];

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
      sessionHistory(id);
      return id;
    });
    const bench = new Bench({ time: 100 });
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
    const bench = new Bench({ time: 100 });
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
  const bench = new Bench({ time: 100 });
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
      const bench = new Bench({ time: 100 });
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

try {
  await runSessionHydration();
  await runBusFanout();
  await runMessageSerialization();
  await runStorageSessionList();
  mkdirSync("bench-results", { recursive: true });
  await Bun.write(join("bench-results", "session.json"), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  Storage.reset();
  Bus.reset();
}

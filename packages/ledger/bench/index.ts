// Run with: bun run bench/index.ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Bench } from "tinybench";
import type { Message } from "@openomni/protocol";
import { Bus } from "../test/helpers/observation";
import { Session } from "../src/session/index.ts";
import { initialize } from "../src/storage/initialize.ts";
import { Storage } from "../src/storage/storage.ts";

type BenchmarkResult = {
  name: string;
  unit: "ns/op";
  value: number;
};

const MODEL = { providerID: "bench", modelID: "bench" };
const results: BenchmarkResult[] = [];

function userMessage(sessionID: string, index: number): Message.Info {
  return {
    id: `message-${sessionID}-${index}`,
    sessionID,
    role: "user",
    time: { created: 1_700_000_000_000 + index },
    agent: "bench-agent",
    model: MODEL,
    system: "You are benchmarking OpenOmni session storage hotpaths.",
    tools: {
      session_read: true,
      session_write: true,
      bus_publish: true,
    },
    variant: "benchmark",
  };
}

function assistantMessage(sessionID: string, index: number): Message.Info {
  return {
    id: `assistant-${sessionID}-${index}`,
    sessionID,
    role: "assistant",
    time: {
      created: 1_700_000_000_000 + index,
      completed: 1_700_000_000_050 + index,
    },
    parentID: `message-${sessionID}-${index}`,
    modelID: MODEL.modelID,
    providerID: MODEL.providerID,
    agent: "bench-agent",
    path: {
      cwd: "/tmp/openomni",
      root: "/tmp/openomni",
    },
    cost: 0.00042,
    tokens: {
      input: 512,
      output: 128,
      reasoning: 64,
      cache: { read: 32, write: 16 },
    },
    finish: "stop",
  };
}

function recordResults(suite: string, bench: Bench): void {
  console.log(`\n${suite}`);
  console.table(bench.table());

  for (const task of bench.tasks) {
    const result = task.result;
    if (!result || !("latency" in result)) continue;
    const meanMs = result.latency.mean;
    results.push({
      name: `${suite}/${task.name}`,
      unit: "ns/op",
      value: Math.round(meanMs * 1_000_000),
    });
  }
}

async function runSessionHydration(): Promise<void> {
  Storage.reset();
  initialize({ dbPath: ":memory:" });
  Bus.reset();

  const sessions = Array.from({ length: 100 }, (_, sessionIndex) => {
    const session = Session.create({ title: `bench-session-${sessionIndex}`, model: MODEL });
    for (let messageIndex = 0; messageIndex < 10; messageIndex += 1) {
      Session.addMessage(session.id, userMessage(session.id, messageIndex));
    }
    return session;
  });

  const bench = new Bench({ time: 100 });
  let cursor = 0;

  bench.add("get-session", () => {
    const session = sessions[cursor % sessions.length];
    cursor += 1;
    Session.get(session.id);
  });

  bench.add("get-messages", () => {
    const session = sessions[cursor % sessions.length];
    cursor += 1;
    Session.getMessages(session.id);
  });

  await bench.run();
  recordResults("session-hydration", bench);
  Storage.reset();
}

async function runBusFanout(): Promise<void> {
  Storage.reset();
  Bus.reset();

  const subscriberCounts = [10, 50, 100];

  for (const count of subscriberCounts) {
    const bench = new Bench({ time: 100 });
    let handled = 0;
    for (let index = 0; index < count; index += 1) {
      Bus.subscribe(Session.Event.Created, () => {
        handled += 1;
      });
    }

    bench.add(`${count}-subscribers`, async () => {
      Bus.publish(Session.Event.Created, {
        info: {
          id: `fanout-${count}`,
          title: "bench fanout",
          model: MODEL,
          time: { created: Date.now(), updated: Date.now() },
          spawnDepth: 0,
        },
      });
      await Promise.resolve();
      if (handled < 0) throw new Error("unreachable");
    });

    await bench.run();
    recordResults("bus-fanout", bench);
    Bus.reset();
  }
}

async function runMessageSerialization(): Promise<void> {
  Storage.reset();
  Bus.reset();

  const message = assistantMessage("serialization-session", 1);
  const payload = JSON.stringify(message);
  const bench = new Bench({ time: 100 });

  bench.add("stringify-message", () => {
    JSON.stringify(message);
  });

  bench.add("parse-message", () => {
    JSON.parse(payload) satisfies unknown;
  });

  await bench.run();
  recordResults("message-serialization", bench);
  Storage.reset();
}

async function runStorageSessionList(): Promise<void> {
  const bench = new Bench({ time: 100 });
  const sessionCounts = [10, 100, 500];

  for (const count of sessionCounts) {
    Storage.reset();
    initialize({ dbPath: ":memory:" });
    Bus.reset();
    for (let index = 0; index < count; index += 1) {
      Session.create({ title: `list-session-${count}-${index}`, model: MODEL });
    }

    const adapter = Storage.get();
    bench.add(`${count}-sessions`, () => {
      adapter.session.list();
    });
  }

  await bench.run();
  recordResults("storage-session-list", bench);
  Storage.reset();
}

await runSessionHydration();
await runBusFanout();
await runMessageSerialization();
await runStorageSessionList();

mkdirSync("bench-results", { recursive: true });
await Bun.write(join("bench-results", "session.json"), `${JSON.stringify(results, null, 2)}\n`);

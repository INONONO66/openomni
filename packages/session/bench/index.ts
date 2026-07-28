// Run with: bun run bench/index.ts
// Benchmark identity note: `ledger-runtime/query-recent-events` was a moving fixture because it
// shared a mutating runtime with the append benchmark. The fixed-tail query now uses its own
// seeded runtime and publishes a new metric name instead of faking continuity.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BusEvent, Ledger } from "@openomni/protocol";
import { Bench } from "tinybench";
import { Bus } from "../src/bus/index.ts";
import { openLedgerRuntime, type LedgerRuntime } from "../src/ledger/runtime.ts";

type BenchmarkResult = {
  readonly name: string;
  readonly unit: "ns/op";
  readonly value: number;
};

const results: BenchmarkResult[] = [];
function sessionSnapshot(sessionId: string) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: "session-projection-state-v1", state: { id: sessionId } }),
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    expectedHash: `sha256:${digest}` as const,
    ref: {
      version: "content-blob-ref-v1" as const,
      digest,
      byteLength: bytes.byteLength,
      mediaType: "application/json",
    },
  };
}

function recordResults(suite: string, bench: Bench): void {
  console.log(`\n${suite}`);
  console.table(bench.table());
  for (const task of bench.tasks) {
    const result = task.result;
    if (!result || !("latency" in result)) continue;
    results.push({
      name: `${suite}/${task.name}`,
      unit: "ns/op",
      value: Math.round(result.latency.mean * 1_000_000),
    });
  }
}

function sessionAppend(sequence: number) {
  const sessionId = `bench-session-${sequence}`;
  const requestId = `bench-request-${sequence}`;
  const owner = Ledger.OwnerV1.parse({ version: "ledger-owner-v1", ownerKey: sessionId });
  const snapshot = sessionSnapshot(sessionId);
  const event = Ledger.EventV1.parse({
    version: "ledger-event-v1",
    eventId: `bench-event-${sequence}`,
    eventType: "session.opened.v1",
    eventVersion: 1,
    owner,
    payload: {
      version: "native-event-payload-v1",
      eventType: "session.opened.v1",
      subjectId: sessionId,
      occurredAtDbMs: sequence,
      sessionId,
      parentSessionId: "bench-root",
      model: { provider: "bench", id: "bench-model" },
      sessionSnapshotRef: snapshot.ref,
    },
    provenance: {
      version: "native-event-provenance-v1",
      principalId: "bench-principal",
      requestId,
    },
  });
  return {
    request: Ledger.AppendBatch.parse({
      version: "ledger-append-batch-request-v1",
      requestId,
      requestHash: createHash("sha256").update(requestId).digest("hex"),
      principalId: "bench-principal",
      expectedHead: {
        version: "ledger-head-v1",
        owner,
        ownerSeq: 0,
        eventHash: Ledger.GENESIS_V1,
      },
      batch: {
        version: "ledger-batch-v1",
        batchId: `bench-batch-${sequence}`,
        owner,
        events: [event],
      },
    }),
    artifactBlobs: [{ bytes: snapshot.bytes, expectedHash: snapshot.expectedHash }],
  };
}

async function seedSessions(runtime: LedgerRuntime, count: number): Promise<void> {
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const append = sessionAppend(sequence);
    await runtime.append(append.request, { artifactBlobs: append.artifactBlobs });
  }
}

async function runLedgerBenchmarks(root: string): Promise<void> {
  const seededSessions = 128;
  const queryWindow = {
    afterLedgerSeq: seededSessions - 64,
    throughLedgerSeq: seededSessions,
    limit: 64,
  } as const;
  const appendRuntime = openLedgerRuntime({ dbPath: join(root, "ledger-append.db") });
  const queryRuntime = openLedgerRuntime({ dbPath: join(root, "ledger-query.db") });

  try {
    await seedSessions(appendRuntime, seededSessions);
    await seedSessions(queryRuntime, seededSessions);

    let sequence = seededSessions + 1;
    const bench = new Bench({ time: 100 });
    bench.add("append-session-with-projections", async () => {
      const append = sessionAppend(sequence);
      await appendRuntime.append(append.request, { artifactBlobs: append.artifactBlobs });
      sequence += 1;
    });
    bench.add("query-tail-window-64-of-128", async () => {
      await queryRuntime.query((query) => query.eventsByLedgerSequence(queryWindow));
    });
    await bench.run();
    recordResults("ledger-runtime", bench);
  } finally {
    await appendRuntime.close();
    await queryRuntime.close();
  }
}

async function runBusFanout(): Promise<void> {
  Bus.reset();
  const event = BusEvent.define("bench:bus-fanout", Ledger.OwnerV1);
  for (let index = 0; index < 50; index += 1) {
    Bus.subscribe(event, () => undefined);
  }
  const bench = new Bench({ time: 100 });
  bench.add("50-subscribers", async () => {
    Bus.publish(event, { version: "ledger-owner-v1", ownerKey: "bench-owner" });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  });
  await bench.run();
  recordResults("bus-fanout", bench);
  Bus.reset();
}

const root = join(tmpdir(), `openomni-session-bench-${randomUUID()}`);
mkdirSync(root, { recursive: true });
try {
  await runLedgerBenchmarks(root);
  await runBusFanout();
} finally {
  rmSync(root, { recursive: true, force: true });
}

mkdirSync("bench-results", { recursive: true });
await Bun.write(join("bench-results", "session.json"), `${JSON.stringify(results, null, 2)}\n`);

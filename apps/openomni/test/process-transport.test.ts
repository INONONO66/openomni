import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegationKernel } from "../src/delegation/kernel";
import { createProcessDriver } from "../src/delegation/process-driver";
import {
  PROCESS_WORKER_ACK,
  ProcessWorkerRequest,
  serveProcessWorker,
} from "../src/delegation/process-entry";

const WORKER = { model: { provider: "anthropic", id: "test-model" }, apiKey: "test-key" } as const;
const RESIDENT = { role: "resident", depth: 0 } as const;

/** A `core` worker asked for independent work: the address that resolves to `process`. */
function independentAsk(text: string, deadline: number) {
  return {
    address: { kind: "core", scope: "independent" },
    mode: "ask",
    payload: { text },
    deadline,
  };
}

function fakeEntry(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "openomni-process-"));
  const path = join(directory, "entry.ts");
  writeFileSync(path, body);
  return path;
}

function kernelWith(entryPath: string, now = () => Date.now()) {
  return createDelegationKernel({
    drivers: {
      process: createProcessDriver({ command: [process.execPath, entryPath], worker: WORKER }),
    },
    now,
    newDelegationId: () => "d-1",
  });
}

// --- the child half, in-process -------------------------------------------

test("the entry acks before it works, so delivery is observable separately from the result", async () => {
  const written: string[] = [];
  const order: string[] = [];
  await serveProcessWorker(
    JSON.stringify({
      delegationId: "d-1",
      instruction: "summarize",
      acceptanceCriteria: [],
      origin: { role: "worker", depth: 1 },
      model: WORKER.model,
      apiKey: WORKER.apiKey,
    }),
    (line) => {
      written.push(line);
      order.push("write");
    },
    async () => {
      order.push("run");
      return "done";
    },
  );

  expect(written[0]).toBe(PROCESS_WORKER_ACK);
  expect(order).toEqual(["write", "run", "write"]);
  expect(JSON.parse(written[1] ?? "")).toEqual({ status: "completed", output: "done" });
});

test("a worker that throws is a failed result, not a lost delivery", async () => {
  const written: string[] = [];
  await serveProcessWorker(
    JSON.stringify({
      delegationId: "d-1",
      instruction: "summarize",
      acceptanceCriteria: [],
      origin: { role: "worker", depth: 1 },
      model: WORKER.model,
      apiKey: WORKER.apiKey,
    }),
    (line) => written.push(line),
    async () => {
      throw new Error("model refused");
    },
  );

  expect(written[0]).toBe(PROCESS_WORKER_ACK);
  expect(JSON.parse(written[1] ?? "")).toEqual({ status: "failed", error: "model refused" });
});

test("a request that does not parse never acks, so the parent reads it as undelivered", async () => {
  const written: string[] = [];
  await expect(
    serveProcessWorker('{"instruction":"no origin"}', (line) => written.push(line), async () => "x"),
  ).rejects.toThrow();
  expect(written).toEqual([]);
});

test("the request schema refuses an origin the parent did not carry whole", () => {
  const parsed = ProcessWorkerRequest.safeParse({
    delegationId: "d-1",
    instruction: "x",
    acceptanceCriteria: [],
    origin: { role: "worker" },
    model: WORKER.model,
    apiKey: WORKER.apiKey,
  });
  expect(parsed.success).toBe(false);
});

// --- the wire, against real child processes -------------------------------

test("an independent delegation settles completed through a real process", async () => {
  const entry = fakeEntry(`
    const line = await new Response(Bun.stdin.stream()).text();
    const request = JSON.parse(line);
    console.log(JSON.stringify({ delivered: true }));
    console.log(JSON.stringify({ status: "completed", output: "handled: " + request.instruction + " pid:" + process.pid }));
  `);
  const kernel = kernelWith(entry);

  const result = await kernel.delegate(independentAsk("audit the ledger", Date.now() + 20_000), RESIDENT);

  if ("refused" in result) throw new Error(`unexpectedly refused: ${result.refused}`);
  expect(result.handle.transport).toBe("process");
  // "process" has to mean an actual OS process: the child reports its own pid,
  // and a driver that quietly ran the work in-process would report ours.
  const [text, pid] = (result.settled as { output: string }).output.split(" pid:");
  expect(text).toBe("handled: audit the ledger");
  expect(Number(pid)).toBeGreaterThan(0);
  expect(Number(pid)).not.toBe(process.pid);
}, 30_000);

test("a child that dies before acking is delivery_failed, never a worker who declined", async () => {
  const entry = fakeEntry(`
    console.error("boot failed: missing credentials");
    process.exit(3);
  `);
  const kernel = kernelWith(entry);

  const result = await kernel.delegate(independentAsk("audit", Date.now() + 20_000), RESIDENT);

  if ("refused" in result) throw new Error(result.refused);
  expect(result.settled.status).toBe("delivery_failed");
  const settled = result.settled as { status: "delivery_failed"; reason: string };
  expect(settled.reason).toContain("before acknowledging delivery");
  expect(settled.reason).toContain("missing credentials");
}, 30_000);

test("a command that cannot start at all is delivery_failed", async () => {
  const kernel = createDelegationKernel({
    drivers: {
      process: createProcessDriver({
        command: ["/nonexistent/openomni-worker-binary"],
        worker: WORKER,
      }),
    },
    now: () => Date.now(),
    newDelegationId: () => "d-1",
  });

  const result = await kernel.delegate(independentAsk("audit", Date.now() + 20_000), RESIDENT);

  if ("refused" in result) throw new Error(result.refused);
  expect(result.settled.status).toBe("delivery_failed");
}, 30_000);

test("a child that acks and then breaks is failed, because a worker held the request", async () => {
  const entry = fakeEntry(`
    await new Response(Bun.stdin.stream()).text();
    console.log(JSON.stringify({ delivered: true }));
    process.exit(1);
  `);
  const kernel = kernelWith(entry);

  const result = await kernel.delegate(independentAsk("audit", Date.now() + 20_000), RESIDENT);

  if ("refused" in result) throw new Error(result.refused);
  expect(result.settled).toMatchObject({
    status: "failed",
    error: "worker process exited without a result",
  });
}, 30_000);

test("a child that acks and then goes silent is no_response, and leaves no orphan", async () => {
  const entry = fakeEntry(`
    await new Response(Bun.stdin.stream()).text();
    console.log(JSON.stringify({ delivered: true }));
    await new Promise(() => {});
  `);
  const kernel = kernelWith(entry);

  const started = Date.now();
  const result = await kernel.delegate(independentAsk("audit", started + 700), RESIDENT);

  // The deadline decides this, not the driver: the worker took delivery.
  if ("refused" in result) throw new Error(result.refused);
  expect(result.settled.status).toBe("no_response");

}, 30_000);

/**
 * Liveness, observed rather than assumed. Each child writes the clock to a
 * file while it runs, so "we killed it" is the file going quiet — a driver
 * that merely stopped reading would leave the file still growing.
 *
 * Two kills, two different reachable paths, one test each: the deadline path
 * (abort fires, the worker never answers) and the answered-but-lingering path
 * (no abort ever fires, so only the `finally` reaps it).
 */
async function heartbeatChild(after: string): Promise<{ entry: string; marker: string }> {
  const directory = mkdtempSync(join(tmpdir(), "openomni-process-"));
  const marker = join(directory, "alive");
  const entry = join(directory, "entry.ts");
  writeFileSync(
    entry,
    `await new Response(Bun.stdin.stream()).text();
     console.log(JSON.stringify({ delivered: true }));
     ${after}
     for (;;) { await Bun.write(${JSON.stringify(marker)}, String(Date.now())); await Bun.sleep(50); }`,
  );
  return { entry, marker };
}

async function wentQuiet(marker: string): Promise<boolean> {
  const first = await Bun.file(marker).text();
  await Bun.sleep(400);
  return (await Bun.file(marker).text()) === first;
}

test("a child that took delivery and then hung is killed at the deadline", async () => {
  const { entry, marker } = await heartbeatChild("");
  const kernel = kernelWith(entry);

  const result = await kernel.delegate(independentAsk("audit", Date.now() + 700), RESIDENT);

  if ("refused" in result) throw new Error(result.refused);
  expect(result.settled.status).toBe("no_response");
  expect(await wentQuiet(marker)).toBe(true);
}, 30_000);

test("a child that answered and then refused to exit is still reaped", async () => {
  const { entry, marker } = await heartbeatChild(
    'console.log(JSON.stringify({ status: "completed", output: "answered" }));',
  );
  const kernel = kernelWith(entry);

  const result = await kernel.delegate(independentAsk("audit", Date.now() + 20_000), RESIDENT);

  // No abort fires on this path, so nothing but the driver's own cleanup
  // stands between a well-behaved answer and a process left running forever.
  if ("refused" in result) throw new Error(result.refused);
  expect(result.settled).toMatchObject({ status: "completed", output: "answered" });
  expect(await wentQuiet(marker)).toBe(true);
}, 30_000);

test("a malformed result line is the worker's failure, not a delivery failure", async () => {
  const entry = fakeEntry(`
    await new Response(Bun.stdin.stream()).text();
    console.log(JSON.stringify({ delivered: true }));
    console.log(JSON.stringify({ status: "finished", output: "wrong vocabulary" }));
  `);
  const kernel = kernelWith(entry);

  const result = await kernel.delegate(independentAsk("audit", Date.now() + 20_000), RESIDENT);

  if ("refused" in result) throw new Error(result.refused);
  expect(result.settled.status).toBe("failed");
  expect((result.settled as { error: string }).error).toContain("malformed result");
}, 30_000);

test("the child receives the origin the parent admitted, so the depth cap crosses the boundary", async () => {
  const entry = fakeEntry(`
    const line = await new Response(Bun.stdin.stream()).text();
    const request = JSON.parse(line);
    console.log(JSON.stringify({ delivered: true }));
    console.log(JSON.stringify({ status: "completed", output: JSON.stringify(request.origin) }));
  `);
  const kernel = kernelWith(entry);

  const result = await kernel.delegate(independentAsk("audit", Date.now() + 20_000), RESIDENT);

  if ("refused" in result) throw new Error(result.refused);
  expect(JSON.parse((result.settled as { output: string }).output)).toEqual({
    role: "worker",
    depth: 1,
  });
}, 30_000);

test("a worker may not open a process at all, so the driver is never reached", async () => {
  const entry = fakeEntry(`
    await new Response(Bun.stdin.stream()).text();
    console.log(JSON.stringify({ delivered: true }));
    console.log(JSON.stringify({ status: "completed", output: "should not happen" }));
  `);
  const kernel = kernelWith(entry);

  const result = await kernel.delegate(independentAsk("audit", Date.now() + 20_000), {
    role: "worker",
    depth: 1,
  });

  if (!("refused" in result)) throw new Error("a worker opened a process");
  expect(result.refused).toContain("same-domain inline child");
}, 30_000);

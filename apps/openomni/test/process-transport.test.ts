import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegationStore } from "@openomni/ledger";
import type { Admitted } from "../src/delegation/admission";
import { createDelegationKernel } from "../src/delegation/kernel";
import { createProcessDriver } from "../src/delegation/process-driver";
import {
  createChildKernel,
  PROCESS_WORKER_ACK,
  ProcessWorkerRequest,
  serveProcessWorker,
} from "../src/delegation/process-entry";
import { WorkerRunError } from "../src/composition/worker-session";
import { RESIDENT, useDelegationStore } from "./helpers/delegation";

useDelegationStore();

const directories: string[] = [];
afterEach(() => {
  const errors: unknown[] = [];
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "process fixture cleanup failed");
});

const WORKER = { model: { provider: "anthropic", id: "test-model" }, apiKey: "test-key" } as const;

function independentAsk(text: string, deadline: number) {
  return {
    address: { kind: "core", scope: "independent" },
    operation: "ask",
    payload: { text },
    deadline,
  };
}

function fakeEntry(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "openomni-process-"));
  directories.push(directory);
  const path = join(directory, "entry.ts");
  writeFileSync(path, body);
  return path;
}

function kernelWith(entryPath: string, now = () => Date.now()) {
  let issued = 0;
  return createDelegationKernel({
    drivers: {
      process: createProcessDriver({ command: [process.execPath, entryPath], worker: WORKER }),
    },
    now,
    newDelegationId: () => `d-${++issued}`,
    wake: () => undefined,
  });
}

// Child half ---------------------------------------------------------------

test("the entry acks before it works, so delivery is observable separately from result", async () => {
  const written: string[] = [];
  const order: string[] = [];
  await serveProcessWorker(
    JSON.stringify({
      delegationId: "d-1",
      workerRunId: "run-1",
      operation: "ask",
      instruction: "summarize",
      acceptanceCriteria: [],
      origin: { role: "worker", depth: 1, sessionId: "session-origin" },
      model: WORKER.model,
      apiKey: WORKER.apiKey,
    }),
    (line) => {
      written.push(line);
      order.push("write");
    },
    async () => {
      order.push("run");
      return { text: "done", tokens: 7 };
    },
  );
  expect(written[0]).toBe(PROCESS_WORKER_ACK);
  expect(order).toEqual(["write", "run", "write"]);
  expect(JSON.parse(written[1] ?? "")).toEqual({
    status: "completed",
    output: "done",
    workerRunId: "run-1",
    usage: { tokens: 7 },
  });
});

test("worker errors preserve a driven run identity and primitive failure", async () => {
  const base = {
    delegationId: "d-1",
    workerRunId: "run-1",
    operation: "ask",
    instruction: "summarize",
    acceptanceCriteria: [],
    origin: { role: "worker", depth: 1, sessionId: "session-origin" },
    model: WORKER.model,
    apiKey: WORKER.apiKey,
  } as const;
  for (const [error, expected] of [
    [
      new WorkerRunError("failed", "run-2"),
      { status: "failed", error: "failed", workerRunId: "run-2" },
    ],
    ["primitive", { status: "failed", error: "primitive", workerRunId: "run-1" }],
  ] as const) {
    const written: string[] = [];
    await serveProcessWorker(
      JSON.stringify(base),
      (line) => written.push(line),
      async () => {
        throw error;
      },
    );
    expect(JSON.parse(written[1] ?? "")).toEqual(expected);
  }
});

test("a worker that throws is a failed result, not a lost delivery", async () => {
  const written: string[] = [];
  await serveProcessWorker(
    JSON.stringify({
      delegationId: "d-1",
      workerRunId: "run-1",
      operation: "ask",
      instruction: "summarize",
      acceptanceCriteria: [],
      origin: { role: "worker", depth: 1, sessionId: "session-origin" },
      model: WORKER.model,
      apiKey: WORKER.apiKey,
    }),
    (line) => written.push(line),
    async () => {
      throw new Error("model refused");
    },
  );
  expect(written[0]).toBe(PROCESS_WORKER_ACK);
  expect(JSON.parse(written[1] ?? "")).toEqual({
    status: "failed",
    error: "model refused",
    workerRunId: "run-1",
  });
});

test("a request that does not parse never acks", async () => {
  const written: string[] = [];
  await expect(
    serveProcessWorker(
      '{"instruction":"no origin"}',
      (line) => written.push(line),
      async () => ({ text: "x", tokens: 0 }),
    ),
  ).rejects.toThrow("Invalid input");
  expect(written).toEqual([]);
});

test("the request schema carries lineage and refuses a malformed origin", () => {
  expect(
    ProcessWorkerRequest.safeParse({
      delegationId: "d-1",
      operation: "ask",
      instruction: "x",
      acceptanceCriteria: [],
      origin: { role: "worker" },
      model: WORKER.model,
      apiKey: WORKER.apiKey,
    }).success,
  ).toBe(false);
  expect(
    ProcessWorkerRequest.parse({
      delegationId: "d-1",
      workerRunId: "run-1",
      operation: "ask",
      instruction: "x",
      acceptanceCriteria: [],
      origin: {
        role: "worker",
        depth: 1,
        sessionId: "s",
        parentDelegationId: "p",
        rootDelegationId: "r",
      },
      model: WORKER.model,
      apiKey: WORKER.apiKey,
    }).origin,
  ).toMatchObject({ parentDelegationId: "p", rootDelegationId: "r" });
});

// Parent/child wire --------------------------------------------------------

test("an independent delegation returns its handle before a real process result, then settles completed", async () => {
  const entry = fakeEntry(`
    const line = await new Response(Bun.stdin.stream()).text();
    const request = JSON.parse(line);
    console.log(JSON.stringify({ delivered: true }));
    console.log(JSON.stringify({ status: "completed", output: "handled: " + request.instruction + " pid:" + process.pid, workerRunId: request.workerRunId }));
  `);
  const kernel = kernelWith(entry);
  const result = await kernel.delegate(
    independentAsk("audit the ledger", Date.now() + 20_000),
    RESIDENT,
  );
  if ("refused" in result) throw new Error(result.refused);
  expect(result.handle.transport).toBe("process");
  expect(result.settled).toBeUndefined();
  const settled = await kernel.awaitDelegation(result.handle.delegationId);
  if (settled.kind !== "settled" || settled.settlement.status !== "completed") {
    throw new Error("process did not settle completed");
  }
  const [text, pid] = settled.settlement.output.split(" pid:");
  expect(text).toBe("handled: audit the ledger");
  expect(Number(pid)).not.toBe(process.pid);
});

test("a child that dies before acking is delivery_failed", async () => {
  const entry = fakeEntry(`console.error("boot failed: missing credentials"); process.exit(3);`);
  const kernel = kernelWith(entry);
  const result = await kernel.delegate(independentAsk("audit", Date.now() + 20_000), RESIDENT);
  if ("refused" in result) throw new Error(result.refused);
  const settled = await kernel.awaitDelegation(result.handle.delegationId);
  expect(settled).toMatchObject({ kind: "settled", settlement: { status: "delivery_failed" } });
  if (settled.kind === "settled" && settled.settlement.status === "delivery_failed") {
    expect(settled.settlement.reason).toContain("before acknowledging delivery");
  }
});

test("a command that cannot start is delivery_failed", async () => {
  const kernel = createDelegationKernel({
    drivers: {
      process: createProcessDriver({
        command: ["/nonexistent/openomni-worker-binary"],
        worker: WORKER,
      }),
    },
    now: () => Date.now(),
    newDelegationId: () => "d-missing",
    wake: () => undefined,
  });
  const result = await kernel.delegate(independentAsk("audit", Date.now() + 20_000), RESIDENT);
  if ("refused" in result) throw new Error(result.refused);
  const settled = await kernel.awaitDelegation(result.handle.delegationId);
  expect(settled).toMatchObject({ kind: "settled", settlement: { status: "delivery_failed" } });
});

test("a child that acks and then breaks is failed, because delivery was acknowledged", async () => {
  const entry = fakeEntry(`
    await new Response(Bun.stdin.stream()).text();
    console.log(JSON.stringify({ delivered: true }));
    process.exit(1);
  `);
  const kernel = kernelWith(entry);
  const result = await kernel.delegate(independentAsk("audit", Date.now() + 20_000), RESIDENT);
  if ("refused" in result) throw new Error(result.refused);
  const settled = await kernel.awaitDelegation(result.handle.delegationId);
  expect(settled).toMatchObject({
    kind: "settled",
    settlement: { status: "failed", error: "worker process exited without a result" },
  });
});

test("an acknowledged silent child reaches no_response at its deadline", async () => {
  const entry = fakeEntry(`
    await new Response(Bun.stdin.stream()).text();
    console.log(JSON.stringify({ delivered: true }));
    await new Promise(() => {});
  `);
  const kernel = kernelWith(entry);
  const result = await kernel.delegate(independentAsk("audit", Date.now() + 80), RESIDENT);
  if ("refused" in result) throw new Error(result.refused);
  const settled = await kernel.awaitDelegation(result.handle.delegationId);
  expect(settled).toMatchObject({ kind: "settled", settlement: { status: "no_response" } });
});

test("a process request without its admitted worker identity is refused before spawn", async () => {
  const driver = createProcessDriver({ command: ["/not-used"], worker: WORKER });
  const admitted = {
    ok: true,
    delegationId: "d",
    request: independentAsk("work", Date.now() + 1_000),
    transport: "process",
    effectiveDeadline: Date.now() + 1_000,
    rootDelegationId: "d",
    childOrigin: { role: "worker", depth: 1, sessionId: "session-origin" },
  } as Admitted;
  const outcome = await driver.run(
    admitted,
    {
      delegationId: "d",
      operation: "ask",
      address: { kind: "core", scope: "independent" },
      transport: "process",
      deadline: Date.now() + 1_000,
      rootDelegationId: "d",
    },
    new AbortController().signal,
  );
  expect(outcome.status).toBe("delivery_failed");
});

test("a non-JSON result after ack is worker failure", async () => {
  const entry = fakeEntry(`
    await new Response(Bun.stdin.stream()).text();
    console.log(JSON.stringify({ delivered: true }));
    console.log("not-json");
  `);
  const kernel = kernelWith(entry);
  const result = await kernel.delegate(independentAsk("audit", Date.now() + 20_000), RESIDENT);
  if ("refused" in result) throw new Error(result.refused);
  const settled = await kernel.awaitDelegation(result.handle.delegationId);
  expect(settled).toMatchObject({ kind: "settled", settlement: { status: "failed" } });
});

test("a malformed result after ack is worker failure", async () => {
  const entry = fakeEntry(`
    await new Response(Bun.stdin.stream()).text();
    console.log(JSON.stringify({ delivered: true }));
    console.log(JSON.stringify({ status: "finished", output: "wrong vocabulary" }));
  `);
  const kernel = kernelWith(entry);
  const result = await kernel.delegate(independentAsk("audit", Date.now() + 20_000), RESIDENT);
  if ("refused" in result) throw new Error(result.refused);
  const settled = await kernel.awaitDelegation(result.handle.delegationId);
  expect(settled).toMatchObject({ kind: "settled", settlement: { status: "failed" } });
});

test("the child receives the admission-stamped worker lineage", async () => {
  const entry = fakeEntry(`
    const request = JSON.parse(await new Response(Bun.stdin.stream()).text());
    console.log(JSON.stringify({ delivered: true }));
    console.log(JSON.stringify({ status: "completed", output: JSON.stringify(request.origin), workerRunId: request.workerRunId }));
  `);
  const kernel = kernelWith(entry);
  const result = await kernel.delegate(independentAsk("audit", Date.now() + 20_000), RESIDENT);
  if ("refused" in result) throw new Error(result.refused);
  const settled = await kernel.awaitDelegation(result.handle.delegationId);
  if (settled.kind !== "settled" || settled.settlement.status !== "completed")
    throw new Error("missing result");
  expect(JSON.parse(settled.settlement.output)).toMatchObject({
    role: "worker",
    depth: 1,
    sessionId: "session-origin",
  });
});

test("a worker may not open process work", async () => {
  const entry = fakeEntry(`console.log(JSON.stringify({ delivered: true }));`);
  const kernel = kernelWith(entry);
  const result = await kernel.delegate(independentAsk("audit", Date.now() + 20_000), {
    role: "worker",
    depth: 1,
    sessionId: "session-origin",
  });
  expect(result).toMatchObject({ refused: expect.stringContaining("same-domain inline child") });
});

test("a child kernel does not sweep the host's open process row", () => {
  DelegationStore.create({
    delegationId: "d-parent-open",
    operation: "ask",
    address: { kind: "core", scope: "independent" },
    transport: "process",
    deadline: 5_000,
    rootDelegationId: "d-parent-open",
    origin: RESIDENT,
    instruction: "parent work",
    status: "open",
    createdAt: 1_000,
  });
  const kernel = createChildKernel(async () => ({ text: "inner", tokens: 0 }));
  expect(DelegationStore.get("d-parent-open")?.status).toBe("open");
  kernel.stop();
});

test("the child kernel has no process driver", async () => {
  const kernel = createChildKernel(async () => ({ text: "inner", tokens: 0 }));
  const result = await kernel.delegate(independentAsk("fork", Date.now() + 5_000), RESIDENT);
  if ("refused" in result) throw new Error(result.refused);
  const settled = await kernel.awaitDelegation(result.handle.delegationId);
  expect(settled).toMatchObject({
    kind: "settled",
    settlement: { status: "delivery_failed", reason: "no driver for process transport" },
  });
});

test("concurrent process delegations have independent durable ids and answers", async () => {
  const entry = fakeEntry(`
    const request = JSON.parse(await new Response(Bun.stdin.stream()).text());
    console.log(JSON.stringify({ delivered: true }));
    console.log(JSON.stringify({ status: "completed", output: request.instruction, workerRunId: request.workerRunId }));
  `);
  const kernel = kernelWith(entry);
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      kernel.delegate(independentAsk(`job-${index}`, Date.now() + 20_000), RESIDENT),
    ),
  );
  const settled = await Promise.all(
    results.map(async (result) => {
      if ("refused" in result) throw new Error(result.refused);
      const outcome = await kernel.awaitDelegation(result.handle.delegationId);
      if (outcome.kind !== "settled" || outcome.settlement.status !== "completed")
        throw new Error("missing result");
      return outcome.settlement.output;
    }),
  );
  expect(new Set(settled).size).toBe(4);
});

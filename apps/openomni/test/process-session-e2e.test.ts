import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegationStore, initialize, SessionHandleStore, Storage } from "@openomni/ledger";
import { Bus, closeSessions, sweepSessions, type SessionRuntime } from "@openomni/agent";
import { Delegation } from "@openomni/protocol";
import { createProcessDriver } from "../src/delegation/process-driver";
import { createDelegationKernel, type DriverOutcome } from "../src/delegation/kernel";
import { createWorkerSessionRunner } from "../src/composition/worker-session";
import { ProcessWorkerResult } from "../src/delegation/process-entry";
import { z } from "zod";

const Request = z.object({
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(z.object({ type: z.string(), text: z.string().optional() })),
      ]),
    }),
  ),
});
function response(tool: boolean): Response {
  const block = tool
    ? { type: "tool_use", id: "recursive-call", name: "delegate", input: {} }
    : { type: "text", text: "" };
  const delta = tool
    ? {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          operation: "ask",
          scope: "inline",
          instruction: "child leaf",
          timeoutMs: 10000,
        }),
      }
    : { type: "text_delta", text: "process completed" };
  const frames = [
    {
      type: "message_start",
      message: {
        id: crypto.randomUUID(),
        type: "message",
        role: "assistant",
        model: "claude-opus-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("spawned production entry uses the session loop and permits a recursive inline child", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openomni-937-process-"));
  const dbPath = join(directory, "chat.sqlite");
  let requests = 0;
  const authorization: (string | null)[] = [];
  const bodies: z.infer<typeof Request>[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests += 1;
      authorization.push(request.headers.get("x-api-key"));
      bodies.push(Request.parse(await request.json()));
      return response(requests === 1);
    },
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    initialize({ dbPath });
    SessionHandleStore.materialize({
      id: "process-parent",
      role: "resident",
      parentId: null,
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 0,
      actionId: "parent-config",
      at: 1,
    });
    Storage.reset();
    child = Bun.spawn([process.execPath, "apps/openomni/src/delegation/process-entry.ts"], {
      cwd: new URL("../../..", import.meta.url).pathname,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENOMNI_DISABLE_MODELS_FETCH: "1" },
    });
    const stdout = new Response(child.stdout as ReadableStream<Uint8Array>).text();
    const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    const stdin = child.stdin as import("bun").FileSink;
    stdin.write(
      `${JSON.stringify({ delegationId: "process-worker", workerRunId: "commissioned-run", operation: "assign", instruction: "ask an inline child then report", acceptanceCriteria: ["child replied"], origin: { role: "worker", depth: 1, sessionId: "process-parent" }, model: { provider: "anthropic", id: "claude-opus-4-5" }, apiKey: "process-key", transport: { baseUrl: `http://127.0.0.1:${provider.port}/v1` }, dbPath })}\n`,
    );
    stdin.end();
    expect(await child.exited).toBe(0);
    const output = await stdout;
    const error = await stderr;
    console.log("937 actual process", JSON.stringify({ pid: child.pid, requests, output, error }));
    const lines = output.trim().split("\n");
    expect(JSON.parse(lines[0] ?? "null")).toEqual({ delivered: true });
    const result = ProcessWorkerResult.parse(JSON.parse(lines[1] ?? "null"));
    expect(result).toMatchObject({ status: "completed", output: "process completed" });
    expect(requests).toBe(3);
    expect(authorization).toEqual(["process-key", "process-key", "process-key"]);
    expect(JSON.stringify(bodies[1])).toContain("child leaf");
    const db = new Database(dbPath, { readonly: true });
    try {
      const workers = db
        .query("SELECT id, parent_id FROM session WHERE role='worker' ORDER BY time_created, id")
        .all();
      expect(workers).toHaveLength(2);
      expect(workers).toContainEqual({ id: "process-worker", parent_id: "process-parent" });
      const childRow = workers.find(
        (row) =>
          typeof row === "object" && row !== null && "id" in row && row.id !== "process-worker",
      );
      expect(childRow).toMatchObject({ parent_id: "process-worker" });
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM action WHERE kind='turn' AND json_extract(intent,'$.phase')='stop'",
          )
          .get(),
      ).toEqual({ count: 3 });
      expect(
        db.query("SELECT count(*) AS count FROM session WHERE lease_owner IS NOT NULL").get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  } finally {
    child?.kill();
    if (child !== undefined) await child.exited;
    await provider.stop(true);
    Storage.reset();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("process recovery event deadline")), 10000);
    }),
  ]).finally(() => clearTimeout(timer));
}

for (const mode of ["cancel", "cancel-commit-window", "crash"] as const) {
  test(`real process ${mode} followed by boot lease-expiry recovery`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "937-process-recovery-"));
    const dbPath = join(directory, "live.sqlite");
    const cancelPath = join(directory, "cancel.sqlite");
    const delegationId = `worker-${mode}`;
    const entered = Promise.withResolvers<void>();
    const releaseProvider = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<DriverOutcome>();
    let requests = 0;
    let acknowledgments = 0;
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        await request.text();
        requests += 1;
        if (requests === 1) {
          entered.resolve();
          await releaseProvider.promise;
        }
        return response(false);
      },
    });
    const model = { provider: "anthropic", id: "claude-opus-4-5" };
    const transport = { baseUrl: `http://127.0.0.1:${provider.port}/v1` };
    const driver = createProcessDriver({
      command: [
        process.execPath,
        new URL("../src/delegation/process-entry.ts", import.meta.url).pathname,
      ],
      worker: { model, apiKey: "recovery-key", transport },
      dbPath,
    });
    initialize({ dbPath });
    SessionHandleStore.materialize({
      id: "process-parent",
      role: "resident",
      parentId: null,
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 0,
      actionId: "parent-config",
      at: 1,
    });
    const kernel = createDelegationKernel({
      drivers: {
        process: {
          async run(admitted, handle, signal, report) {
            const result = await driver.run(admitted, handle, signal, {
              delivered() {
                acknowledgments += 1;
                report?.delivered();
              },
            });
            joined.resolve(result);
            return result;
          },
        },
      },
      now: Date.now,
      wake: () => undefined,
      newDelegationId: () => delegationId,
      bootSweep: false,
      events: Bus,
    });
    let runtime: SessionRuntime | undefined;
    let dispatched = false;
    let copied = false;
    const unsubscribe = Bus.subscribe(Delegation.Events.Settled, (event) => {
      if (
        mode !== "cancel-commit-window" ||
        event.delegationId !== delegationId ||
        event.status !== "cancelled"
      )
        return;
      // Durable cancellation already won, but the process driver's abort listener
      // has not run. Recovery must also honor this crash window.
      const db = new Database(dbPath, { readonly: true });
      try {
        writeFileSync(cancelPath, db.serialize());
      } finally {
        db.close();
      }
      copied = true;
    });
    try {
      const delegated = await kernel.delegate(
        {
          address: { kind: "core", scope: "independent" },
          operation: "ask",
          payload: { text: "do work" },
          deadline: Date.now() + 30000,
        },
        { role: "resident", depth: 0, sessionId: "process-parent" },
      );
      if (!("handle" in delegated)) throw new Error(delegated.refused);
      dispatched = true;
      await bounded(entered.promise);
      expect(acknowledgments).toBe(1);
      const row = SessionHandleStore.row(delegationId);
      const open = SessionHandleStore.openTurns(SessionHandleStore.tree(delegationId))[0];
      if (open === undefined || row.leaseExpiresAt === null || row.leaseOwner === null)
        throw new Error("missing live worker lease/turn");
      if (mode === "crash") {
        process.kill(Number(row.leaseOwner.split(":")[0]), "SIGKILL");
      } else {
        expect((await kernel.cancelDelegation(delegationId)).status).toBe("cancelled");
      }
      const outcome = await bounded(joined.promise);
      expect(outcome.status).toBe(mode === "crash" ? "failed" : "cancelled");
      kernel.stop();
      releaseProvider.resolve();
      Storage.reset();
      if (mode === "cancel-commit-window") expect(copied).toBe(true);
      initialize({ dbPath: mode === "cancel-commit-window" ? cancelPath : dbPath });
      const prefix = SessionHandleStore.tree(delegationId);
      runtime = {
        observations: Bus,
        clock: () => (row.leaseExpiresAt === null ? 0 : row.leaseExpiresAt + 1),
      };
      const runner = createWorkerSessionRunner({
        model,
        apiKey: "recovery-key",
        transport,
        kernel: () => kernel,
        sessionRuntime: runtime,
      });
      await bounded(sweepSessions((sessionRow) => runner.runnerFor(sessionRow), runtime));
      const tree = SessionHandleStore.tree(delegationId);
      const terminal = tree.flatMap((action) => {
        const value = SessionHandleStore.turnTerminal(action);
        return value === undefined ? [] : [value];
      });
      console.log(
        "937 R2",
        JSON.stringify({
          mode,
          outcome,
          requests,
          terminal,
          delegation: DelegationStore.get(delegationId)?.settled?.status,
        }),
      );
      expect(requests).toBe(mode === "crash" ? 2 : 1);
      expect(terminal).toMatchObject([
        {
          turnId: open.turnId,
          kind: mode === "crash" ? "result" : "interrupted",
          resumeCount: mode === "crash" ? 1 : 0,
        },
      ]);
      expect(tree.find((action) => SessionHandleStore.turnTerminal(action) !== undefined)?.id).toBe(
        open.resultId,
      );
      expect(tree.slice(0, prefix.length)).toEqual(prefix);
      expect(SessionHandleStore.openTurns(tree)).toHaveLength(0);
      expect(SessionHandleStore.row(delegationId).leaseOwner).toBeNull();
      if (mode !== "crash")
        expect(DelegationStore.get(delegationId)?.settled?.status).toBe("cancelled");
    } finally {
      unsubscribe();
      kernel.stop();
      releaseProvider.resolve();
      if (dispatched) await bounded(joined.promise);
      if (runtime !== undefined) await closeSessions(runtime);
      await provider.stop(true);
      Storage.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
}

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Bus, closeSessions, sweepSessions, type SessionRuntime } from "@openomni/agent";
import { initialize, SessionHandleStore, Storage, DelegationStore } from "@openomni/ledger";
import { L0Observation } from "@openomni/protocol";
import { createProcessDriver } from "../src/delegation/process-driver";
import { createDelegationKernel, type DriverOutcome } from "../src/delegation/kernel";
import { createWorkerSessionRunner } from "../src/composition/worker-session";

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("exact-event deadline")), 10000);
    }),
  ]).finally(() => clearTimeout(timer));
}

function response(): Response {
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
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "cancelled work resumed" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

// The reviewer's live-expiry counterexample: actual delegate -> process driver ->
// production process-entry, file SQLite reopened at the recorded lease expiry.
// The adjacent turn.post/session boundary is after the chat runner returns, so
// a subscription removed in the runner's finally block cannot protect the seal.
for (const boundary of ["llm-intent", "before-seal"] as const) {
  test(`cancellation at recovered ${boundary} stops a real live expired worker`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "openomni-live-expiry-"));
    const dbPath = join(directory, "worker.sqlite");
    const id = `live-expiry-${boundary}`;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<DriverOutcome>();
    const cancellation = Promise.withResolvers<void>();
    const cancelledBeforeRequest: boolean[] = [];
    let requests = 0;
    let acknowledgments = 0;
    let armed = false;
    let pid: number | undefined;
    let cancellationResult: object | undefined;
    let trigger: object | undefined;
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        await request.text();
        requests += 1;
        cancelledBeforeRequest.push(DelegationStore.get(id)?.settled?.status === "cancelled");
        if (requests === 1) {
          entered.resolve();
          await release.promise;
        }
        return response();
      },
    });
    const model = { provider: "anthropic", id: "claude-opus-4-5" };
    const transport = { baseUrl: `http://127.0.0.1:${provider.port}/v1` };
    initialize({ dbPath });
    SessionHandleStore.materialize({
      id: "live-parent",
      role: "resident",
      parentId: null,
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 0,
      actionId: "parent-config",
      at: 1,
    });
    const driver = createProcessDriver({
      command: [
        process.execPath,
        new URL("../src/delegation/process-entry.ts", import.meta.url).pathname,
      ],
      worker: { model, apiKey: "independent-key", transport },
      dbPath,
    });
    const kernel = createDelegationKernel({
      drivers: {
        process: {
          async run(admitted, handle, signal, report) {
            const value = await driver.run(admitted, handle, signal, {
              delivered() {
                acknowledgments += 1;
                report?.delivered();
              },
            });
            joined.resolve(value);
            return value; // no held driver delivery or fake driver outcome
          },
        },
      },
      now: Date.now,
      wake: () => undefined,
      newDelegationId: () => id,
      bootSweep: false,
      events: Bus,
    });
    let runtime: SessionRuntime | undefined;
    let dispatched = false;
    const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
      if (!armed || event.sessionId !== id) return;
      const node = SessionHandleStore.tree(id).find((n) => n.id === event.id);
      if (node === undefined) return;
      const matches =
        boundary === "llm-intent"
          ? node.kind === "llm" &&
            z.object({ phase: z.literal("intent") }).safeParse(node.intent.value).success
          : node.kind === "policy.decision" &&
            z
              .object({ hook: z.literal("turn.post"), op: z.literal("session") })
              .safeParse(node.intent.value).success;
      if (!matches) return;
      armed = false;
      let originalChildAlive = false;
      if (pid !== undefined) {
        try {
          process.kill(pid, 0);
          originalChildAlive = true;
        } catch {
          originalChildAlive = false;
        }
      }
      trigger = {
        id: node.id,
        kind: node.kind,
        intent: node.intent.value,
        requests,
        originalChildAlive,
        recoveryFence: SessionHandleStore.row(id).leaseFence,
        openTurns: SessionHandleStore.openTurns(SessionHandleStore.tree(id)).length,
      };
      kernel.cancelDelegation(id).then((result) => {
        cancellationResult = result;
        cancellation.resolve();
      }, cancellation.reject);
    });
    try {
      const delegated = await kernel.delegate(
        {
          address: { kind: "core", scope: "independent" },
          operation: "ask",
          payload: { text: "do work" },
          deadline: Date.now() + 30000,
        },
        { role: "resident", depth: 0, sessionId: "live-parent" },
      );
      if (!("handle" in delegated)) throw new Error(delegated.refused);
      dispatched = true;
      await bounded(entered.promise);
      const row = SessionHandleStore.row(id);
      const open = SessionHandleStore.openTurns(SessionHandleStore.tree(id))[0];
      if (!open || row.leaseExpiresAt === null || row.leaseOwner === null) {
        throw new Error("missing process turn/lease");
      }
      pid = Number(row.leaseOwner.split(":")[0]);
      Storage.reset();
      initialize({ dbPath });
      const prefix = SessionHandleStore.tree(id);
      const clock = row.leaseExpiresAt + 1;
      runtime = { observations: Bus, clock: () => clock };
      const factory = createWorkerSessionRunner({
        model,
        apiKey: "independent-key",
        transport,
        kernel: () => kernel,
        sessionRuntime: runtime,
      });
      armed = true;
      await bounded(sweepSessions((row) => factory.runnerFor(row), runtime));
      await bounded(cancellation.promise);
      const outcome = await bounded(joined.promise);
      const tree = SessionHandleStore.tree(id);
      const terminals = tree.flatMap((n) => {
        const terminal = SessionHandleStore.turnTerminal(n);
        return terminal ? [{ actionId: n.id, ...terminal }] : [];
      });
      const output = {
        boundary,
        pid,
        acknowledgments,
        originalFence: row.leaseFence,
        clock,
        trigger,
        outcome,
        cancellationResult,
        requests,
        cancelledBeforeRequest,
        durableStatus: DelegationStore.get(id)?.settled?.status,
        terminals,
        prefixUnchanged: JSON.stringify(tree.slice(0, prefix.length)) === JSON.stringify(prefix),
        originalTurnId: open.turnId,
        originalResultId: open.resultId,
        openTurns: SessionHandleStore.openTurns(tree).length,
        leaseOwner: SessionHandleStore.row(id).leaseOwner,
        pendingInbox: SessionHandleStore.pendingInbox(id).map((i) => i.kind),
      };
      console.log("LIVE CANCELLATION", JSON.stringify(output));
      expect(output.durableStatus).toBe("cancelled");
      expect(outcome.status).toBe("cancelled");
      expect(requests).toBe(boundary === "llm-intent" ? 1 : 2);
      expect(cancelledBeforeRequest).toEqual(boundary === "llm-intent" ? [false] : [false, false]);
      expect(trigger).toMatchObject({
        requests: boundary === "llm-intent" ? 1 : 2,
        originalChildAlive: true,
        recoveryFence: row.leaseFence + 1,
        openTurns: 1,
      });
      expect(acknowledgments).toBe(1);
      expect(terminals).toMatchObject([
        { actionId: open.resultId, turnId: open.turnId, kind: "interrupted", resumeCount: 1 },
      ]);
      expect(output.prefixUnchanged).toBe(true);
      expect(output.openTurns).toBe(0);
      expect(output.leaseOwner).toBeNull();
      expect(output.pendingInbox).toEqual([]);
    } finally {
      armed = false;
      unsubscribe();
      release.resolve();
      kernel.stop();
      if (dispatched) await bounded(joined.promise);
      if (runtime) await closeSessions(runtime);
      await provider.stop(true);
      Storage.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
}

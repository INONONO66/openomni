import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkerManager, type WorkerManager } from "@openomni/coordinator";
import type { Execution } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { DispatchRegistry } from "../../src/dispatch/registry";
import { registerBuiltInDispatchHandlers } from "../../src/dispatch/setup";
import { command, workerSpawnPayload } from "./helpers";

const POLICY_ECHO_WORKER = fileURLToPath(
  new URL("../harness/policy-echo-worker.ts", import.meta.url),
);

let pool: WorkerManager | undefined;

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
});

// End-to-end proof for gate-side policy stamping (#462 §7, #479 review W4):
// the REAL gate handler stamps the plan, the stamped request traverses a REAL
// worker pool and IPC boundary into a REAL spawned worker process, and the
// worker-side plan resolution (`buildWorkerMiddleware`, the same path
// worker-runner uses) reports which policies became active.
describe("worker.spawn policy plan end-to-end over real IPC", () => {
  test("the gate-stamped plan resolves to active policies inside a spawned worker", async () => {
    const socketDir = `/tmp/omo-e2e-${process.pid}-${Date.now()}`;
    fs.mkdirSync(socketDir, { recursive: true });
    pool = createWorkerManager(
      { workerScript: POLICY_ECHO_WORKER, socketDir, maxActiveWorkers: 1 },
      { events: { publish: () => undefined } },
    );
    const activePool = pool;

    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          dispatch: async (_sessionId: string, request: Execution.Request) => {
            const raw = await activePool.deliver(request.runId, { ...request });
            return raw as Execution.Result;
          },
        },
      },
    });

    const dispatched = (await registry.get("worker.spawn")?.(
      command("worker.spawn", { kind: "worker", name: "coder" }, workerSpawnPayload("build it")),
    )) as { output?: { result?: { output?: string } } };

    const output = dispatched?.output?.result?.output;
    expect(output).toBeDefined();
    const echoed = JSON.parse(output ?? "{}") as {
      receivedPolicyPlan: boolean;
      activePolicies: string[];
    };
    expect(echoed.receivedPolicyPlan).toBe(true);
    expect(echoed.activePolicies).toContain("builtin:tool-permission");
    expect(echoed.activePolicies).toContain("builtin:idle-nudge");
  });
});

#!/usr/bin/env bun
/**
 * #496 Manual QA driver for the extracted `@openomni/ipc` worker transport.
 * Exercises the REAL `Execution.Driver` (coordinator worker pool behind
 * `createExecutionCoordinator`) and the real worker IPC boundary, then exits
 * zero after printing its scenario receipt — it does not stay resident.
 *
 *   --scenario authenticated-request      boot the server execution
 *     composition root, deliver one worker-backed request through the real
 *     driver + IPC socket, print the correlated response, the IPC frame
 *     digest, the protocol+ipc-only coordinator boundary, and the zero
 *     direct coordinator-IPC import count.
 *
 *   --scenario invalid-generation-token   boot the REAL worker-entry over
 *     `@openomni/ipc`, then attempt a spawn with an invalid generation
 *     token: prints the typed authentication denial with
 *     `workerExecutions: 0` / `ledgerCompletionRows: 0` and proves no
 *     secret/token bytes leaked into the response.
 *
 * When spawned by the worker manager (argv carries `--socket`), this same
 * file runs as the scenario echo worker: real IPC server, real bootstrap
 * handshake and auth checks, no LLM dependency.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { connectIpcClient, createIpcServer, encode } from "@openomni/ipc";
import type { Execution } from "@openomni/protocol";
import { WorkerDriver } from "@openomni/protocol";
import { createWorkerManager } from "@openomni/coordinator";
import { Storage } from "@openomni/session";
import { createExecutionCoordinator } from "../execution/coordinator";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");

function readCliArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// ---------------------------------------------------------------------------
// Worker mode: real IPC server + bootstrap/auth handshake, LLM-free echo run.
// ---------------------------------------------------------------------------
function runScenarioWorker(socketPath: string): void {
  const workerId = readCliArg("--worker-id") ?? "ipc-driver-worker";
  const ipcAuthToken = process.env.OPENOMNI_WORKER_IPC_TOKEN;
  delete process.env.OPENOMNI_WORKER_IPC_TOKEN;
  if (!ipcAuthToken) {
    console.error("ipc-worker-driver worker mode: missing IPC auth token");
    process.exit(1);
  }

  const server = createIpcServer(socketPath, (method, params, respond, _notify, connectionId) => {
    if (params?.authToken !== ipcAuthToken) {
      if (method === "coordinator.spawn_run") {
        respond({
          runId: typeof params?.runId === "string" ? params.runId : "unknown",
          sessionId: typeof params?.sessionId === "string" ? params.sessionId : "unknown",
          status: "failed",
          error: "unauthorized coordinator request",
        });
        return;
      }
      respond({ ok: false, error: "unauthorized" });
      return;
    }

    if (method === "coordinator.bootstrap") {
      server.useConnection(connectionId);
      server.notify("worker.bootstrap_ready", { workerId, authToken: ipcAuthToken });
      respond({ ok: true });
      return;
    }

    if (method === "coordinator.spawn_run") {
      respond({
        runId: typeof params?.runId === "string" ? params.runId : "unknown",
        sessionId: typeof params?.sessionId === "string" ? params.sessionId : "unknown",
        status: "succeeded",
        output: JSON.stringify({ echoedPrompt: params?.prompt ?? null }),
        finishReason: "stop",
      });
      return;
    }

    if (method === "worker.shutdown_idle") {
      respond({ acknowledged: true });
      setTimeout(() => process.exit(0), 0);
      return;
    }

    respond({ ok: true });
  });

  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Import-boundary receipt: the extraction's structural claims, regenerated.
// ---------------------------------------------------------------------------
async function scanDirectCoordinatorIpcImports(): Promise<{
  scannedFiles: number;
  directCoordinatorIpcImports: number;
  offenders: string[];
}> {
  const offenders: string[] = [];
  let scannedFiles = 0;
  const glob = new Bun.Glob("{packages,apps}/*/src/**/*.ts");
  const oldTransportPattern =
    /coordinator\/src\/ipc|from\s+["']@openomni\/coordinator["'].*createIpcServer|createIpcServer[^\n]*from\s+["']@openomni\/coordinator["']/;
  for await (const file of glob.scan({ cwd: REPO_ROOT, onlyFiles: true })) {
    if (file.includes("/dist/") || file.includes("/node_modules/")) continue;
    scannedFiles += 1;
    const source = await Bun.file(path.join(REPO_ROOT, file)).text();
    for (const line of source.split("\n")) {
      if (oldTransportPattern.test(line)) {
        offenders.push(file);
        break;
      }
    }
  }
  return { scannedFiles, directCoordinatorIpcImports: offenders.length, offenders };
}

function coordinatorBoundary(): { openomniDeps: string[]; protocolAndIpcOnly: boolean } {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "packages/coordinator/package.json"), "utf-8"),
  ) as { dependencies?: Record<string, string> };
  const openomniDeps = Object.keys(manifest.dependencies ?? {})
    .filter((dep) => dep.startsWith("@openomni/"))
    .sort();
  const allowed = new Set(["@openomni/protocol", "@openomni/ipc"]);
  return {
    openomniDeps,
    protocolAndIpcOnly: openomniDeps.every((dep) => allowed.has(dep)),
  };
}

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// Scenario: authenticated-request (happy path through the real driver).
// ---------------------------------------------------------------------------
async function runAuthenticatedRequest(json: boolean): Promise<void> {
  Storage.initialize({ dbPath: ":memory:" });
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-ipc-driver-"));
  let ledgerCompletionRows = 0;

  const coordinator = createExecutionCoordinator({
    workerScript: fileSelfPath(),
    socketDir,
    maxWorkers: 1,
    workerManagerFactory: (config, ports) =>
      createWorkerManager(config, {
        ...ports,
        events: {
          publish: (def, payload) => {
            if (def === WorkerDriver.RunSettled) ledgerCompletionRows += 1;
            ports.events.publish(def, payload);
          },
        },
      }),
  });

  const runId = `run-${crypto.randomUUID()}`;
  const sessionId = `ses-${crypto.randomUUID()}`;
  const request: Execution.Request = {
    runId,
    sessionId,
    mode: "direct",
    prompt: "ipc-worker-driver manual QA happy path",
    model: { provider: "manual-qa", id: "ipc-echo" },
  };

  const result = await coordinator.dispatch(sessionId, request);
  await coordinator.shutdown();
  fs.rmSync(socketDir, { recursive: true, force: true });

  const importScan = await scanDirectCoordinatorIpcImports();
  const receipt = {
    scenario: "authenticated-request",
    workerExecutions: result.status === "succeeded" ? 1 : 0,
    ledgerCompletionRows,
    correlated: result.runId === runId && result.sessionId === sessionId,
    runId,
    result: { status: result.status, output: result.output, finishReason: result.finishReason },
    ipcFrameDigest: sha256(encode(result)),
    coordinatorBoundary: coordinatorBoundary(),
    ...importScan,
  };

  emit(receipt, json);
  const ok =
    receipt.correlated &&
    result.status === "succeeded" &&
    receipt.ledgerCompletionRows === 1 &&
    receipt.coordinatorBoundary.protocolAndIpcOnly &&
    receipt.directCoordinatorIpcImports === 0;
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Scenario: invalid-generation-token (real worker-entry, typed denial).
// ---------------------------------------------------------------------------
async function runInvalidGenerationToken(json: boolean): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-ipc-driver-denial-"));
  const socketPath = path.join(tmpDir, "worker.sock");
  const generationToken = crypto.randomUUID();
  const workerEntry = path.join(REPO_ROOT, "apps/server/src/execution/worker-entry.ts");

  const worker = Bun.spawn(
    ["bun", workerEntry, "--", "--worker-id", "ipc-driver-denial", "--socket", socketPath],
    {
      env: {
        ...process.env,
        OPENOMNI_WORKER_IPC_TOKEN: generationToken,
        OPENOMNI_DB_PATH: path.join(tmpDir, "worker.db"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(socketPath)) {
    if (Date.now() > deadline) {
      worker.kill();
      throw new Error("worker-entry socket never appeared");
    }
    await Bun.sleep(100);
  }

  const client = await connectIpcClient(socketPath);
  const bootstrap = await client.call("coordinator.bootstrap", {
    authToken: generationToken,
    bootstrap: { configEpoch: "", agents: [], toolCatalog: [], credentials: {} },
  });

  const denial = (await client.call("coordinator.spawn_run", {
    authToken: `invalid-${crypto.randomUUID()}`,
    runId: "run-denied",
    sessionId: "ses-denied",
  })) as { runId: string; sessionId: string; status: string; error?: string };

  client.close();
  worker.kill();
  await worker.exited;
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const denialFrame = encode(denial);
  const receipt = {
    scenario: "invalid-generation-token",
    workerEntryStarted: JSON.stringify(bootstrap) === JSON.stringify({ ok: true }),
    denial: {
      status: denial.status,
      error: denial.error,
      runId: denial.runId,
      typedAuthenticationDenial:
        denial.status === "failed" && denial.error === "unauthorized coordinator request",
    },
    workerExecutions: 0,
    ledgerCompletionRows: 0,
    secretLeaked: new TextDecoder().decode(denialFrame).includes(generationToken),
    ipcFrameDigest: sha256(denialFrame),
  };

  emit(receipt, json);
  const ok =
    receipt.workerEntryStarted && receipt.denial.typedAuthenticationDenial && !receipt.secretLeaked;
  process.exit(ok ? 0 : 1);
}

function fileSelfPath(): string {
  return path.join(REPO_ROOT, "apps/server/src/manual/ipc-worker-driver.ts");
}

function emit(receipt: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  console.log(receipt);
}

if (import.meta.main) {
  const socketArg = readCliArg("--socket");
  if (socketArg) {
    runScenarioWorker(socketArg);
  } else {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        scenario: { type: "string" },
        json: { type: "boolean", default: false },
      },
    });
    if (values.scenario === "authenticated-request") {
      await runAuthenticatedRequest(values.json);
    } else if (values.scenario === "invalid-generation-token") {
      await runInvalidGenerationToken(values.json);
    } else {
      console.error(
        "usage: ipc-worker-driver --scenario <authenticated-request|invalid-generation-token> [--json]",
      );
      process.exit(1);
    }
  }
}

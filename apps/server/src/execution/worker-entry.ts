import { createIpcServer } from "@openomni/coordinator";
import { Operational } from "@openomni/protocol";
import { initialize, Bus, BusPersistence } from "@openomni/session";
import { BackgroundManager, InjectionQueue, WorkspaceLock } from "@openomni/openomni";
import { loadConfig } from "../config";
import { WorkerBootstrapHandler } from "./worker-bootstrap-handler";
import { resolveWorkerDbPath } from "./worker-runtime";
import { WorkerHeartbeat } from "./worker-heartbeat";
import { WorkerIpcHandlers } from "./worker-ipc-handlers";
import type { WorkerRunState } from "./worker-run-state";
import { WorkerRunner } from "./worker-runner";

function readCliArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const workerId = readCliArg("--worker-id") ?? "unknown";
const socketPath = readCliArg("--socket");
const ipcAuthToken = process.env.OPENOMNI_WORKER_IPC_TOKEN;
delete process.env.OPENOMNI_WORKER_IPC_TOKEN;

if (!socketPath) {
  Bus.publish(Operational.Error, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: "worker-entry: missing --socket argument",
  });
  process.exit(1);
}

if (!ipcAuthToken) {
  Bus.publish(Operational.Error, {
    traceId: crypto.randomUUID(),
    time: Date.now(),
    component: "server",
    msg: "worker-entry: missing IPC auth token",
  });
  process.exit(1);
}

const config = loadConfig();
initialize({
  dbPath: resolveWorkerDbPath(config),
});
BusPersistence.start();

const activeRuns: WorkerRunState.ActiveRunRegistry = new Map();
const workerBootstrapState = WorkerBootstrapHandler.createState();
const injectionQueue = InjectionQueue.create();

const backgroundManager = BackgroundManager.create({
  maxConcurrentPerAgent: 3,
  maxConcurrentTotal: 10,
  maxDepth: 3,
  resolveAuth: workerBootstrapState.resolveAuth,
  allowAuthFallback: false,
});

async function shutdownWorker(exitCode: number): Promise<never> {
  await BusPersistence.flush();
  BusPersistence.stop();
  server.close();
  process.exit(exitCode);
}

const server = createIpcServer(socketPath, (method, params, respond, _notify, connectionId) => {
  if (method === "coordinator.bootstrap") {
    WorkerBootstrapHandler.handleBootstrap({
      params,
      ipcAuthToken,
      workerId,
      server,
      connectionId,
      respond,
      state: workerBootstrapState,
    });
  } else if (method === "coordinator.spawn_run") {
    WorkerRunner.spawnRun({
      params,
      ipcAuthToken,
      workerId,
      server,
      activeRuns,
      bootstrapReady: workerBootstrapState.ready,
      backgroundManager,
      injectionQueue,
      defaultWorkspaceRoot: config.workspace?.root,
      getBootstrap: workerBootstrapState.getBootstrap,
      resolveAuth: workerBootstrapState.resolveAuth,
      respond,
    });
  } else if (method === "coordinator.cancel_run") {
    respond(WorkerIpcHandlers.cancelRun({ params, ipcAuthToken, activeRuns }));
  } else if (method === "worker.deliver_message") {
    respond(
      WorkerIpcHandlers.deliverMessage({
        params,
        ipcAuthToken,
        workerId,
        activeRuns,
        injectionQueue,
      }),
    );
  } else if (method === "worker.shutdown_idle") {
    const result = WorkerIpcHandlers.canShutdownIdle({ params, ipcAuthToken, activeRuns });
    respond(result);
    if (result.acknowledged) {
      setTimeout(() => {
        void shutdownWorker(0);
      }, 0);
    }
  } else if (method === "worker.tool_call_settled") {
    respond(
      WorkerIpcHandlers.toolCallSettled({
        params,
        ipcAuthToken,
        clearUnsafe: WorkspaceLock.clearUnsafe,
      }),
    );
  } else {
    respond({ ok: true });
  }
});

WorkerHeartbeat.start({
  workerId,
  ipcAuthToken,
  server,
  getActiveRunIds: () => [...activeRuns.keys()],
  getConfigEpoch: () => workerBootstrapState.getBootstrap()?.configEpoch ?? "",
});

process.on("SIGTERM", async () => {
  await shutdownWorker(0);
});

Bus.publish(Operational.Info, {
  traceId: crypto.randomUUID(),
  time: Date.now(),
  component: "server",
  msg: "worker started",
  context: { workerId, pid: process.pid, socketPath },
});

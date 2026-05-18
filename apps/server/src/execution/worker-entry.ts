import { AgentRegistry } from "@openomni/agent";
import type { Auth } from "@openomni/llm";
import { createIpcServer } from "@openomni/coordinator";
import { Operational, WorkerBootstrap } from "@openomni/protocol";
import { initialize, Bus, BusPersistence } from "@openomni/session";
import { BackgroundManager } from "@openomni/openomni";
import { loadConfig } from "../config";
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

let workerBootstrap: WorkerBootstrap.Bootstrap | null = null;
const activeRuns: WorkerRunState.ActiveRunRegistry = new Map();
let resolveBootstrapReady: () => void = () => undefined;
let rejectBootstrapReady: (_error: Error) => void = () => undefined;
const bootstrapReady = new Promise<void>((resolve, reject) => {
  resolveBootstrapReady = resolve;
  rejectBootstrapReady = reject;
});

const backgroundManager = BackgroundManager.create({
  maxConcurrentPerAgent: 3,
  maxConcurrentTotal: 10,
  maxDepth: 3,
  resolveAuth: resolveBootstrapAuth,
  allowAuthFallback: false,
});

async function shutdownWorker(exitCode: number): Promise<never> {
  await BusPersistence.flush();
  BusPersistence.stop();
  server.close();
  process.exit(exitCode);
}

function resolveBootstrapAuth(provider: string): Auth.Info | undefined {
  const credentials = workerBootstrap?.credentials;
  if (!credentials) return undefined;

  const prefix = provider.toUpperCase();
  const apiKey = credentials[`${prefix}_API_KEY`];
  const baseURL = credentials[`${prefix}_BASE_URL`];

  if (baseURL) {
    return { type: "proxy", baseURL, ...(apiKey ? { apiKey } : {}) };
  }
  if (apiKey) {
    return { type: "api", key: apiKey };
  }
  return undefined;
}

const server = createIpcServer(socketPath, (method, params, respond, _notify, connectionId) => {
  if (method === "coordinator.bootstrap") {
    if (params?.authToken !== ipcAuthToken) {
      respond({ ok: false, error: "unauthorized" });
      return;
    }

    try {
      const bootstrap = WorkerBootstrap.Bootstrap.parse(params.bootstrap);
      workerBootstrap = bootstrap;
      const agentDefs = bootstrap.agents.map((agent) => ({
        name: agent.name,
        description: agent.description,
        model: agent.model,
        systemPrompt: agent.systemPrompt,
        tools: agent.tools.allow ?? [],
        permissions: agent.permissions,
        budget: agent.budget,
      }));
      AgentRegistry.replaceAll(agentDefs);
      server.useConnection(connectionId);
      resolveBootstrapReady();
      server.notify("worker.bootstrap_ready", { workerId, authToken: ipcAuthToken });
      Bus.publish(Operational.Info, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "worker bootstrap received",
        context: {
          workerId,
          agents: bootstrap.agents.length,
          mcpTools: bootstrap.toolCatalog.length,
        },
      });
      respond({ ok: true });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      rejectBootstrapReady(error);
      respond({ ok: false, error: error.message });
      Bus.publish(Operational.Error, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "worker bootstrap failed",
        context: {
          workerId,
          err: error.message,
        },
      });
    }
  } else if (method === "coordinator.spawn_run") {
    WorkerRunner.spawnRun({
      params,
      ipcAuthToken,
      workerId,
      server,
      activeRuns,
      bootstrapReady,
      backgroundManager,
      defaultWorkspaceRoot: config.workspace?.root,
      getBootstrap: () => workerBootstrap,
      resolveAuth: resolveBootstrapAuth,
      respond,
    });
  } else if (method === "coordinator.cancel_run") {
    respond(WorkerIpcHandlers.cancelRun({ params, ipcAuthToken, activeRuns }));
  } else if (method === "worker.deliver_message") {
    respond(WorkerIpcHandlers.deliverMessage({ params, ipcAuthToken, workerId, activeRuns }));
  } else if (method === "worker.shutdown_idle") {
    const result = WorkerIpcHandlers.canShutdownIdle({ params, ipcAuthToken, activeRuns });
    respond(result);
    if (result.acknowledged) {
      setTimeout(() => {
        void shutdownWorker(0);
      }, 0);
    }
  } else {
    respond({ ok: true });
  }
});

WorkerHeartbeat.start({
  workerId,
  ipcAuthToken,
  server,
  getActiveRunIds: () => [...activeRuns.keys()],
  getConfigEpoch: () => workerBootstrap?.configEpoch ?? "",
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

export { workerBootstrap };

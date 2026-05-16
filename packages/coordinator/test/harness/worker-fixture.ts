import { createIpcServer } from "../../src/ipc";

function readCliArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const workerId = readCliArg("--worker-id") ?? "fixture";
const socketPath = readCliArg("--socket");
const ipcAuthToken = process.env.OPENOMNI_WORKER_IPC_TOKEN;
delete process.env.OPENOMNI_WORKER_IPC_TOKEN;

if (!socketPath) {
  console.error("worker-fixture: missing --socket argument");
  process.exit(1);
}

if (!ipcAuthToken) {
  console.error("worker-fixture: missing IPC auth token");
  process.exit(1);
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const server = createIpcServer(socketPath, (method, params, respond, _notify, connectionId) => {
  if (method === "coordinator.bootstrap") {
    if (params?.authToken !== ipcAuthToken) {
      respond({ ok: false, error: "unauthorized" });
      return;
    }
    server.useConnection(connectionId);
    server.notify("worker.bootstrap_ready", { workerId, authToken: ipcAuthToken });
    respond({ ok: true });
    return;
  }

  if (method === "coordinator.spawn_run") {
    if (params?.authToken !== ipcAuthToken) {
      respond({
        runId: typeof params?.runId === "string" ? params.runId : "unknown",
        sessionId: typeof params?.sessionId === "string" ? params.sessionId : "unknown",
        status: "failed",
        error: "unauthorized coordinator request",
      });
      return;
    }
    const runId = typeof params?.runId === "string" ? params.runId : "unknown";
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "unknown";
    const delayMs = asNumber(params?.delayMs, 0);
    const envName = typeof params?.envName === "string" ? params.envName : undefined;

    setTimeout(() => {
      respond({
        accepted: true,
        workerId,
        runId,
        sessionId,
        delayMs,
        envValue: envName ? process.env[envName] : undefined,
      });
    }, delayMs);
    return;
  }

  if (method === "coordinator.cancel_run") {
    if (params?.authToken !== ipcAuthToken) {
      respond({ cancelled: false, error: "unauthorized coordinator request" });
      return;
    }
    respond({ cancelled: true });
    return;
  }

  respond({ ok: true });
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});

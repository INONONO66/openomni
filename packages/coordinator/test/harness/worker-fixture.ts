import { createIpcServer } from "../../src/ipc";

const args = process.argv.slice(2);
const workerId = args[args.indexOf("--worker-id") + 1] ?? "fixture";
const socketPath = args[args.indexOf("--socket") + 1];

if (!socketPath) {
  console.error("worker-fixture: missing --socket argument");
  process.exit(1);
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const server = createIpcServer(socketPath, (method, params, respond) => {
  if (method === "coordinator.spawn_run") {
    const runId = typeof params?.runId === "string" ? params.runId : "unknown";
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "unknown";
    const delayMs = asNumber(params?.delayMs, 0);

    setTimeout(() => {
      respond({ accepted: true, workerId, runId, sessionId, delayMs });
    }, delayMs);
    return;
  }

  if (method === "coordinator.cancel_run") {
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

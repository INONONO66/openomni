import { createIpcServer } from "../ipc/server.js";

const args = process.argv.slice(2);
const workerId = args[args.indexOf("--worker-id") + 1] ?? "unknown";
const socketPath = args[args.indexOf("--socket") + 1];

if (!socketPath) {
  console.error("worker-entry: missing --socket argument");
  process.exit(1);
}

const server = createIpcServer(socketPath, (method, params, respond) => {
  if (method === "coordinator.spawn_run") {
    const delayMs = typeof params?.delayMs === "number" ? params.delayMs : 0;
    const runId = typeof params?.runId === "string" ? params.runId : "unknown";
    if (delayMs > 0) {
      setTimeout(() => respond({ accepted: true, runId, workerId }), delayMs);
    } else {
      respond({ accepted: true, runId, workerId });
    }
  } else if (method === "coordinator.cancel_run") {
    respond({ cancelled: true });
  } else {
    respond({ ok: true });
  }
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});

console.log(`Worker ${workerId} started (PID ${process.pid}) socket=${socketPath}`);

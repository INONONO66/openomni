import { createIpcServer } from "../../src/ipc";

const args = process.argv.slice(2);
const socketPath = args[args.indexOf("--socket") + 1];

if (!socketPath) {
  console.error("execution-worker-fixture: missing --socket argument");
  process.exit(1);
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const server = createIpcServer(socketPath, (method, params, respond) => {
  if (method !== "coordinator.spawn_run") {
    respond({ ok: true });
    return;
  }

  const runId = typeof params?.runId === "string" ? params.runId : "unknown";
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "unknown";
  const delayMs = asNumber(params?.delayMs, 0);

  setTimeout(() => {
    respond({
      runId,
      sessionId,
      status: "succeeded",
      output: `fixture:${runId}`,
      finishReason: "stop",
    });
  }, delayMs);
});

function shutdown(): void {
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

import { createIpcServer } from "../ipc/server.js";
import { createDaemonWsServer } from "./ws-server.js";
import { createHealthServer } from "./health.js";
import { writePid, removePid } from "./pid.js";

const IPC_SOCKET = process.env.OPENOMNI_IPC_SOCKET ?? "/tmp/openomni-coordinator.sock";
const WS_PORT = parseInt(process.env.OPENOMNI_WS_PORT ?? "9999", 10);
const HEALTH_PORT = parseInt(process.env.OPENOMNI_HEALTH_PORT ?? "9998", 10);
const DRAIN_TIMEOUT_MS = parseInt(process.env.OPENOMNI_DRAIN_TIMEOUT_MS ?? "60000", 10);
const PID_PATH = process.env.OPENOMNI_PID_PATH ?? undefined;

const activeRuns = new Set<string>();

const ipcServer = createIpcServer(IPC_SOCKET, (_method, _params, respond) => {
  // Placeholder — Phase 4.2 (worker pool) fills this in
  respond({ ok: true });
});

const wsServer = createDaemonWsServer(WS_PORT, (cmd, send) => {
  if (cmd.type === "daemon.ping") {
    send({ type: "daemon.pong" });
  } else if (cmd.type === "daemon.health") {
    send({ type: "daemon.health", status: "ok", activeRuns: activeRuns.size });
  }
});

const healthServer = createHealthServer(HEALTH_PORT);

writePid(PID_PATH);

async function shutdown(): Promise<void> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (activeRuns.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  ipcServer.close();
  wsServer.stop();
  healthServer.stop();
  removePid(PID_PATH);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`Coordinator daemon started (PID ${process.pid})`);
console.log(`  IPC:       ${IPC_SOCKET}`);
console.log(`  WebSocket: ws://localhost:${wsServer.port}`);
console.log(`  Health:    http://localhost:${healthServer.port}/health`);

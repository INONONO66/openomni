import { createIpcServer } from "@openomni/ipc";

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

function envNumber(name: string, fallback = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const activeRuns = new Map<string, { sessionId: string; inbox: string[] }>();
const toolCallSettlements = new Map<string, () => void>();

const server = createIpcServer(socketPath, (method, params, respond, _notify, connectionId) => {
  if (method === "coordinator.bootstrap") {
    if (params?.authToken !== ipcAuthToken) {
      respond({ ok: false, error: "unauthorized" });
      return;
    }
    const delayMs = envNumber("OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS", 0);
    setTimeout(() => {
      server.useConnection(connectionId);
      server.notify("worker.bootstrap_ready", { workerId, authToken: ipcAuthToken });
      respond({ ok: true });
    }, delayMs);
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
    const relayTool = params?.relayTool === true;
    const relayRunId = typeof params?.relayRunId === "string" ? params.relayRunId : runId;
    const toolCallId = `fixture-tool-call:${runId}`;
    activeRuns.set(runId, { sessionId, inbox: [] });

    setTimeout(() => {
      void (async () => {
        let toolRelayResult: unknown;
        if (relayTool) {
          const toolCallSettled = new Promise<void>((resolve) => {
            toolCallSettlements.set(toolCallId, resolve);
          });
          toolRelayResult = await server.call("worker.tool_call", {
            authToken: ipcAuthToken,
            runId: relayRunId,
            sessionId: "spoofed-session",
            callId: toolCallId,
            tool: "fixture.tool",
            input: {
              traceId: "spoofed-trace",
              sessionId: "spoofed-session",
              runId: "spoofed-run",
            },
          });
          await toolCallSettled;
        }
        activeRuns.delete(runId);
        respond({
          accepted: true,
          workerId,
          runId,
          sessionId,
          delayMs,
          envValue: envName ? process.env[envName] : undefined,
          toolRelayResult,
        });
      })().catch((error: unknown) => {
        activeRuns.delete(runId);
        toolCallSettlements.delete(toolCallId);
        respond({
          accepted: false,
          workerId,
          runId,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
    return;
  }

  if (method === "worker.tool_call_settled") {
    const callId = typeof params?.callId === "string" ? params.callId : undefined;
    respond({ acknowledged: true });
    if (callId) {
      toolCallSettlements.get(callId)?.();
      toolCallSettlements.delete(callId);
    }
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

  if (method === "worker.deliver_message") {
    if (params?.authToken !== ipcAuthToken) {
      respond({ accepted: false, error: "unauthorized coordinator request" });
      return;
    }
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined;
    const runId = typeof params?.runId === "string" ? params.runId : undefined;
    const message = typeof params?.message === "string" ? params.message : undefined;
    const traceId = typeof params?.traceId === "string" ? params.traceId : undefined;
    const active = [...activeRuns.entries()].find(
      ([activeRunId, run]) =>
        run.sessionId === sessionId && (runId === undefined || activeRunId === runId),
    );
    if (!sessionId || !message || !active) {
      respond({ accepted: false, error: `run not active for session: ${sessionId ?? "unknown"}` });
      return;
    }
    active[1].inbox.push(message);
    // Echo the wire trace so tests pin what actually crossed the boundary.
    respond({ accepted: true, ...(traceId === undefined ? {} : { traceId }) });
    return;
  }

  if (method === "worker.shutdown_idle") {
    if (params?.authToken !== ipcAuthToken) {
      respond({ acknowledged: false, error: "unauthorized coordinator request" });
      return;
    }
    respond({ acknowledged: activeRuns.size === 0 });
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

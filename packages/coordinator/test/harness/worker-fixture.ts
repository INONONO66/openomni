import { readSync } from "node:fs";
import { Ipc } from "@openomni/protocol";
import { createIpcServer } from "../../src/ipc";
import {
  isWorkerBootstrapProof,
  workerBootstrapProof,
  workerGenerationToken,
} from "../../src/worker-supervision/supervisor-process.js";

function readCliArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const workerId = readCliArg("--worker-id") ?? "fixture";
const socketPath = readCliArg("--socket");

if (!socketPath) {
  console.error("worker-fixture: missing --socket argument");
  process.exit(1);
}

function readGenerationToken(): string {
  const key = new Uint8Array(32);
  let offset = 0;
  try {
    while (offset < key.byteLength) {
      const count = readSync(0, key, offset, key.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== key.byteLength) {
      throw new Error("invalid private generation key");
    }
    return workerGenerationToken(key);
  } finally {
    key.fill(0);
  }
}

const ipcAuthToken = readGenerationToken();

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function envNumber(name: string, fallback = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

type FixturePromptControl = Readonly<{
  delayMs?: number;
  crash?: boolean;
  envProbe?: string;
  inspectSpawnFrame?: boolean;
  toolRelay?: Readonly<{ runId?: string }>;
  traceSpoof?: Readonly<{ traceId: string; sessionId: string; runId: string }>;
}>;

function parseFixturePrompt(prompt: unknown): FixturePromptControl {
  if (typeof prompt !== "string") return {};
  try {
    const envelope: unknown = JSON.parse(prompt);
    if (!envelope || typeof envelope !== "object") return {};
    const fixture = (envelope as { fixture?: unknown }).fixture;
    return fixture && typeof fixture === "object" ? (fixture as FixturePromptControl) : {};
  } catch {
    return {};
  }
}

const activeRuns = new Map<string, { sessionId: string; inbox: string[] }>();
let boundRuntimeId: string | undefined;
let boundWorkerId: string | undefined;
let boundGeneration: number | undefined;
let bootstrapAttempts = 0;

const server = createIpcServer(socketPath, (method, params, respond, _notify, connectionId) => {
  if (method === "coordinator.bootstrap") {
    bootstrapAttempts += 1;
    if (
      typeof params?.authToken !== "string" ||
      typeof params.workerId !== "string" ||
      params.workerId !== workerId ||
      typeof params.generation !== "number"
    ) {
      respond({ ok: false, error: "unauthorized" });
      return;
    }
    const separator = params.authToken.indexOf(".");
    const challenge = params.authToken.slice(0, separator);
    const requestProof = params.authToken.slice(separator + 1);
    const requestContext = {
      runtimeId: typeof params.runtimeId === "string" ? params.runtimeId : undefined,
      workerId: params.workerId,
      generation: params.generation,
    };
    if (
      separator < 1 ||
      !isWorkerBootstrapProof(
        requestProof,
        workerBootstrapProof(ipcAuthToken, challenge, "request", requestContext),
      )
    ) {
      respond({ ok: false, error: "unauthorized" });
      return;
    }
    const rejectedAttempts = envNumber("OPENOMNI_WORKER_BOOTSTRAP_REJECTS", 0);
    if (bootstrapAttempts <= rejectedAttempts) {
      respond({ ok: false, error: "bootstrap retry fixture" });
      return;
    }
    boundRuntimeId = typeof params.runtimeId === "string" ? params.runtimeId : undefined;
    boundWorkerId = params.workerId;
    boundGeneration = params.generation;
    const proofContext = {
      runtimeId: boundRuntimeId,
      workerId: boundWorkerId,
      generation: boundGeneration,
    };
    const responseDelayMs = envNumber("OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS", 0);
    const readyDelayMs =
      bootstrapAttempts === 1
        ? envNumber("OPENOMNI_WORKER_FIRST_READY_DELAY_MS", responseDelayMs)
        : responseDelayMs;
    setTimeout(() => {
      respond({ ok: true });
    }, responseDelayMs);
    setTimeout(() => {
      server.useConnection(connectionId);
      server.notify("worker.bootstrap_ready", {
        authToken: workerBootstrapProof(ipcAuthToken, challenge, "ready", proofContext),
        runtimeId: boundRuntimeId,
        workerId: boundWorkerId,
        generation: boundGeneration,
      });
    }, readyDelayMs);
    return;
  }

  if (method === "coordinator.spawn_run") {
    if (params?.authToken !== ipcAuthToken) {
      respond({ runId: "unknown", sessionId: "unknown", status: "failed", error: "unauthorized" });
      return;
    }
    const runId = typeof params?.runId === "string" ? params.runId : "unknown";
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "unknown";
    const runtime = params?.runtime;
    if (runtime !== undefined) {
      const parsed = Ipc.Methods["coordinator.spawn_run"].params.safeParse({
        authToken: ipcAuthToken,
        runId,
        sessionId,
        prompt: typeof params?.prompt === "string" ? params.prompt : "",
        runtime,
      });
      if (
        !parsed.success ||
        parsed.data.runtime.runtimeId !== boundRuntimeId ||
        parsed.data.runtime.workerId !== boundWorkerId ||
        parsed.data.runtime.generation !== boundGeneration
      ) {
        respond({ runId, sessionId, status: "failed", error: "invalid runtime definition" });
        return;
      }
    }
    const fixture = parseFixturePrompt(params?.prompt);
    const delayMs = asNumber(fixture.delayMs, 0);
    const relayTool = fixture.toolRelay !== undefined;
    const relayRunId = fixture.toolRelay?.runId ?? runId;
    const traceSpoof = fixture.traceSpoof ?? {
      traceId: "spoofed-trace",
      sessionId: "spoofed-session",
      runId: "spoofed-run",
    };
    const toolCallId = `fixture-tool-call:${runId}`;
    activeRuns.set(runId, { sessionId, inbox: [] });
    if (fixture.crash === true) {
      process.exit(1);
    }

    setTimeout(() => {
      void (async () => {
        if (relayTool) {
          await server.call("worker.tool_call", {
            authToken: ipcAuthToken,
            workerId: boundWorkerId,
            generation: boundGeneration,
            runId: relayRunId,
            sessionId,
            callId: toolCallId,
            tool: "fixture.tool",
            input: {
              traceId: traceSpoof.traceId,
              sessionId: traceSpoof.sessionId,
              runId: traceSpoof.runId,
            },
          });
        }
        activeRuns.delete(runId);
        respond({
          runId,
          sessionId,
          status: "succeeded",
          output: "fixture complete",
          finishReason: "stop",
        });
      })().catch((error: unknown) => {
        activeRuns.delete(runId);
        respond({
          runId,
          sessionId,
          status: "failed",
          error: error instanceof Error ? error.message : "fixture failed",
        });
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

  if (method === "worker.deliver_message") {
    if (params?.authToken !== ipcAuthToken) {
      respond({ accepted: false, error: "unauthorized coordinator request" });
      return;
    }
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : undefined;
    const runId = typeof params?.runId === "string" ? params.runId : undefined;
    const message = typeof params?.message === "string" ? params.message : undefined;
    const active = [...activeRuns.entries()].find(
      ([activeRunId, run]) =>
        run.sessionId === sessionId && (runId === undefined || activeRunId === runId),
    );
    if (!sessionId || !message || !active) {
      respond({ accepted: false, error: `run not active for session: ${sessionId ?? "unknown"}` });
      return;
    }
    active[1].inbox.push(message);
    respond({ accepted: true });
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

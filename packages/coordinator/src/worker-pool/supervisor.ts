import fs from "node:fs";
import type { Subprocess } from "bun";
import type { WorkerBootstrap } from "@openomni/protocol";
import { connectIpcClient, type IpcClient } from "../ipc/client";

const MAX_RESTARTS_PER_WINDOW = 10;
const RESTART_WINDOW_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;
const WORKER_CONNECT_TIMEOUT_MS = 10_000;
const MAX_DISPATCH_TIMEOUT_MS = 600_000;

export type ToolCallParams = {
  runId: string;
  sessionId: string;
  callId: string;
  tool: string;
  input: Record<string, unknown>;
};

export type ToolCallResult = {
  id: string;
  toolCallId: string;
  output: string;
  isError?: boolean;
};

export type AskMainParams = {
  workerId: string;
  sessionId: string;
  runId?: string;
  question: string;
};

export type AskMainResult = {
  requestId: string;
  accepted: boolean;
  output?: string;
  error?: string;
};

export class WorkerSupervisor {
  private proc: Subprocess | null = null;
  private client: IpcClient | null = null;
  private bootstrapped = false;
  private readonly authToken = crypto.randomUUID();
  private restartCount = 0;
  private restartWindowStart = 0;
  private generation = 0;
  private running = false;
  private stopping = false;
  readonly socketPath: string;

  constructor(
    readonly id: number,
    private readonly script: string,
    socketDir = "/tmp",
    private readonly bootstrap?: WorkerBootstrap.Bootstrap,
    private readonly toolCallHandler?: (params: ToolCallParams) => Promise<ToolCallResult>,
    private readonly snapshotHandler?: (
      workerId: number,
      snapshot: WorkerBootstrap.WorkerSnapshot,
    ) => void,
    private readonly askMainHandler?: (params: AskMainParams) => Promise<AskMainResult>,
  ) {
    this.socketPath = `${socketDir}/openomni-worker-${id}.sock`;
    this.doStart();
  }

  private doStart(): void {
    this.generation += 1;
    this.running = true;
    this.bootstrapped = false;
    this.proc = Bun.spawn(
      ["bun", this.script, "--", "--worker-id", String(this.id), "--socket", this.socketPath],
      {
        env: { ...buildWorkerEnv(process.env), OPENOMNI_WORKER_IPC_TOKEN: this.authToken },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    this.proc.exited.then(() => {
      this.running = false;
      this.bootstrapped = false;
      const prev = this.client;
      this.client = null;
      prev?.close();
      if (!this.stopping) this.scheduleRestart();
    });
    void this.connectWithRetry();
  }

  private async connectWithRetry(): Promise<void> {
    const deadline = Date.now() + WORKER_CONNECT_TIMEOUT_MS;
    let lastError: Error | null = null;
    const bootstrap = this.bootstrap;
    const toolCallHandler = this.toolCallHandler;
    const snapshotHandler = this.snapshotHandler;
    const workerId = this.id;
    const authToken = this.authToken;

    while (Date.now() < deadline && !this.stopping && this.running) {
      if (!fs.existsSync(this.socketPath)) {
        await new Promise<void>((r) => setTimeout(r, 250));
        continue;
      }
      try {
        const c = await connectIpcClient(this.socketPath, {
          connectTimeoutMs: 500,
          onRequest: (method, params, respond) => {
            if (method === "worker.tool_call" && toolCallHandler) {
              const p = params as ToolCallParams;
              toolCallHandler(p)
                .then((result) => respond(result))
                .catch((err) =>
                  respond({
                    id: p.callId,
                    toolCallId: p.callId,
                    output: err instanceof Error ? err.message : String(err),
                    isError: true,
                  }),
                );
              return;
            }

            if (method === "worker.heartbeat") {
              if (snapshotHandler && params?.snapshot) {
                snapshotHandler(workerId, params.snapshot as WorkerBootstrap.WorkerSnapshot);
              }
              respond(null);
              return;
            }

            if (method === "worker.ask_main") {
              const requestId = crypto.randomUUID();
              if (params?.authToken !== authToken) {
                respond({ requestId, accepted: false, error: "unauthorized worker request" });
                return;
              }
              const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
              const question = typeof params?.question === "string" ? params.question : "";
              if (!this.askMainHandler || !sessionId || !question) {
                respond({
                  requestId,
                  accepted: false,
                  error: this.askMainHandler
                    ? "worker.ask_main requires sessionId and question"
                    : "worker.ask_main is not configured",
                });
                return;
              }

              this.askMainHandler({
                workerId: String(workerId),
                sessionId,
                ...(typeof params?.runId === "string" ? { runId: params.runId } : {}),
                question,
              })
                .then((result: AskMainResult) => respond(result))
                .catch((err: unknown) =>
                  respond({
                    requestId,
                    accepted: false,
                    error: err instanceof Error ? err.message : String(err),
                  }),
                );
              return;
            }

            respond(null);
          },
          onNotification: (method, params) => {
            if (method === "worker.bootstrap_ready" && params?.authToken === authToken) {
              this.bootstrapped = true;
            }
          },
        });
        const bootstrapResult = await c.call(
          "coordinator.bootstrap",
          {
            authToken,
            bootstrap: bootstrap ?? {
              configEpoch: "",
              agents: [],
              toolCatalog: [],
              credentials: {},
            },
          },
          5000,
        );
        if (!isBootstrapAccepted(bootstrapResult)) {
          throw new Error("worker bootstrap rejected");
        }
        if (!this.stopping && this.running) {
          this.client = c;
        } else {
          c.close();
        }
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await new Promise<void>((r) => setTimeout(r, 100));
      }
    }

    if (!this.stopping && this.running && lastError) {
      throw lastError;
    }
  }

  private scheduleRestart(): void {
    const now = Date.now();
    if (now - this.restartWindowStart > RESTART_WINDOW_MS) {
      this.restartCount = 0;
      this.restartWindowStart = now;
    }
    this.restartCount++;

    const delay =
      this.restartCount > MAX_RESTARTS_PER_WINDOW
        ? MAX_BACKOFF_MS
        : Math.min(1000 * 2 ** (this.restartCount - 1), MAX_BACKOFF_MS);

    setTimeout(() => {
      if (!this.stopping) this.doStart();
    }, delay);
  }

  isActive(): boolean {
    return this.running;
  }

  isReady(): boolean {
    return this.client?.connected === true && this.bootstrapped;
  }

  getGeneration(): number {
    return this.generation;
  }

  async waitReady(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isReady()) return;
      await new Promise<void>((r) => setTimeout(r, 200));
    }
    throw new Error(`worker ${this.id} not ready after ${timeoutMs}ms`);
  }

  async dispatch(runId: string, params: Record<string, unknown>): Promise<unknown> {
    const c = this.client;
    if (!c?.connected) {
      throw new Error(`worker ${this.id} not available`);
    }
    const budget = (params as { budget?: { maxWallTimeMs?: number } }).budget;
    const timeoutMs = Math.min(
      Math.max(budget?.maxWallTimeMs ?? 300_000, 300_000) + 30_000,
      MAX_DISPATCH_TIMEOUT_MS,
    );
    return c.call(
      "coordinator.spawn_run",
      { authToken: this.authToken, runId, ...params },
      timeoutMs,
    );
  }

  async cancel(runId: string, sessionId: string): Promise<unknown> {
    const c = this.client;
    if (!c?.connected) {
      return { cancelled: false, error: `worker ${this.id} not available` };
    }
    return c.call("coordinator.cancel_run", { authToken: this.authToken, runId, sessionId }, 5_000);
  }

  async deliverMessage(sessionId: string, message: string, runId?: string): Promise<unknown> {
    const c = this.client;
    if (!c?.connected) {
      return { accepted: false, error: `worker ${this.id} not available` };
    }
    return c.call(
      "worker.deliver_message",
      { authToken: this.authToken, sessionId, ...(runId ? { runId } : {}), message },
      5_000,
    );
  }

  async shutdownIdle(): Promise<boolean> {
    const c = this.client;
    if (!c?.connected) {
      await this.stop();
      return true;
    }

    const wasStopping = this.stopping;
    this.stopping = true;
    try {
      const result = await c.call(
        "worker.shutdown_idle",
        { authToken: this.authToken, workerId: String(this.id) },
        5_000,
      );
      if (!isShutdownAcknowledged(result)) {
        this.stopping = wasStopping;
        return false;
      }
    } catch {
      await this.stop();
      return true;
    }

    await this.stop();
    return true;
  }

  forceKill(): void {
    if (this.proc && this.running) {
      this.proc.kill("SIGKILL");
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const c = this.client;
    this.client = null;
    c?.close();
    if (this.proc && this.running) {
      this.proc.kill("SIGTERM");
      await this.proc.exited;
    }
    this.proc = null;
    this.running = false;
  }
}

const workerEnvKeys = new Set([
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "BUN_INSTALL",
  "NODE_ENV",
  "CI",
  "OPENOMNI_DB_PATH",
  "OPENOMNI_MODELS_URL",
  "OPENOMNI_MODELS_PATH",
  "OPENOMNI_DISABLE_MODELS_FETCH",
  "OPENOMNI_WORKER_ENV_FIXTURE",
  "OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS",
]);

function buildWorkerEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of workerEnvKeys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function isBootstrapAccepted(value: unknown): boolean {
  return value !== null && typeof value === "object" && (value as { ok?: unknown }).ok === true;
}

function isShutdownAcknowledged(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { acknowledged?: unknown }).acknowledged === true
  );
}

import fs from "node:fs";
import type { Subprocess } from "bun";
import type { WorkerBootstrap } from "@openomni/protocol";
import { connectIpcClient, type IpcClient } from "../ipc/client";

const MAX_RESTARTS_PER_WINDOW = 10;
const RESTART_WINDOW_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;
const WORKER_CONNECT_TIMEOUT_MS = 10_000;

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

export class WorkerSupervisor {
  private proc: Subprocess | null = null;
  private client: IpcClient | null = null;
  private restartCount = 0;
  private restartWindowStart = 0;
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
  ) {
    this.socketPath = `${socketDir}/openomni-worker-${id}.sock`;
    this.doStart();
  }

  private doStart(): void {
    this.running = true;
    this.proc = Bun.spawn(
      ["bun", this.script, "--worker-id", String(this.id), "--socket", this.socketPath],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    this.proc.exited.then(() => {
      this.running = false;
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

    while (Date.now() < deadline && !this.stopping && this.running) {
      if (!fs.existsSync(this.socketPath)) {
        await new Promise<void>((r) => setTimeout(r, 100));
        continue;
      }
      try {
        const c = await connectIpcClient(this.socketPath, {
          connectTimeoutMs: 500,
          onRequest(method, params, respond) {
            if (method === "worker.ready") {
              respond(
                bootstrap ?? { configEpoch: "", agents: [], toolCatalog: [], credentials: {} },
              );
              return;
            }

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

            respond(null);
          },
        });
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
    return this.client?.connected === true;
  }

  async waitReady(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isReady()) return;
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    throw new Error(`worker ${this.id} not ready after ${timeoutMs}ms`);
  }

  async dispatch(runId: string, params: Record<string, unknown>): Promise<unknown> {
    const c = this.client;
    if (!c?.connected) {
      throw new Error(`worker ${this.id} not available`);
    }
    const budget = (params as { budget?: { maxWallTimeMs?: number } }).budget;
    const timeoutMs = Math.max(budget?.maxWallTimeMs ?? 300_000, 300_000) + 30_000;
    return c.call("coordinator.spawn_run", { runId, ...params }, timeoutMs);
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

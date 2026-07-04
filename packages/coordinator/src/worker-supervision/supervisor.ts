import fs from "node:fs";
import type { Subprocess } from "bun";
import { Operational, type WorkerBootstrap } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { connectIpcClient, type IpcClient } from "../ipc/client";
import { cancelWorkerRun, deliverWorkerMessage, dispatchWorkerRun } from "./supervisor-client.js";
import {
  buildWorkerEnv,
  isBootstrapAccepted,
  isShutdownAcknowledged,
  resolveRestartDelay,
  waitForSupervisorReady,
  waitForWorkerExit,
  workerStopGraceMs,
} from "./supervisor-process.js";
import { handleWorkerRequest } from "./supervisor-requests.js";
import type { ActiveRequest, InboundWaitHandler, ToolCallHandler } from "./supervisor-types.js";

const RESTART_WINDOW_MS = 60_000;
const WORKER_CONNECT_TIMEOUT_MS = 10_000;

export type {
  InboundWaitParams,
  InboundWaitResult,
  ToolCallCancelParams,
  ToolCallContext,
  ToolCallParams,
  ToolCallResult,
} from "./supervisor-types.js";

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
  private readonly activeToolCalls = new Map<string, ActiveRequest>();
  private readonly activeInboundWaitCalls = new Map<string, ActiveRequest>();
  readonly socketPath: string;

  constructor(
    readonly id: number,
    private readonly script: string,
    socketDir = "/tmp",
    private readonly bootstrap?: WorkerBootstrap.Bootstrap,
    private readonly toolCallHandler?: ToolCallHandler,
    private readonly inboundWaitHandler?: InboundWaitHandler,
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
            handleWorkerRequest(method, params, respond, {
              authToken,
              workerId: this.id,
              activeToolCalls: this.activeToolCalls,
              activeInboundWaitCalls: this.activeInboundWaitCalls,
              toolCallHandler: this.toolCallHandler,
              inboundWaitHandler: this.inboundWaitHandler,
              notifyToolCallSettled: async (callId, workspaceRoot) => {
                await c
                  .call(
                    "worker.tool_call_settled",
                    {
                      authToken,
                      callId,
                      ...(workspaceRoot ? { workspaceRoot } : {}),
                    },
                    5_000,
                  )
                  .catch((err) => {
                    console.warn("worker.tool_call_settled notification failed", {
                      callId,
                      workspaceRoot,
                      error: err instanceof Error ? err.message : String(err),
                    });
                  });
              },
            });
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

    setTimeout(() => {
      if (!this.stopping) this.doStart();
    }, resolveRestartDelay(this.restartCount));
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
    return waitForSupervisorReady(this.id, () => this.isReady(), timeoutMs);
  }

  async dispatch(runId: string, params: Record<string, unknown>): Promise<unknown> {
    return dispatchWorkerRun(this.client, this.id, this.authToken, runId, params);
  }

  async cancel(runId: string, sessionId: string): Promise<unknown> {
    return cancelWorkerRun(this.client, this.id, this.authToken, runId, sessionId);
  }

  async deliverMessage(sessionId: string, message: string, runId?: string): Promise<unknown> {
    return deliverWorkerMessage(this.client, this.id, this.authToken, sessionId, message, runId);
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
    if (this.proc && this.running) this.proc.kill("SIGKILL");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const c = this.client;
    this.client = null;
    c?.close();
    const proc = this.proc;
    if (proc && this.running) {
      proc.kill("SIGTERM");
      const graceMs = workerStopGraceMs();
      if ((await waitForWorkerExit(proc, graceMs)) === "timeout") {
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "coordinator.worker",
          msg: "worker did not stop within grace period; sending SIGKILL",
          context: { workerId: this.id, graceMs },
        });
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }
    this.proc = null;
    this.running = false;
  }
}

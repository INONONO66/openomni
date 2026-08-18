import fs from "node:fs";
import type { Subprocess } from "bun";
import {
  type BusEvent,
  Operational,
  WorkerDeliveryError,
  Worker,
  type WorkerBootstrap,
} from "@openomni/protocol";
import {
  connectIpcClient,
  IpcConnectionError,
  type IpcClient,
  IpcTimeoutError,
} from "@openomni/ipc";
import {
  buildWorkerEnv,
  FAST_CRASH_THRESHOLD_MS,
  isBootstrapAccepted,
  isShutdownAcknowledged,
  MAX_CONSECUTIVE_FAST_CRASHES,
  resolveDeliverTimeoutMs,
  resolveRestartDelay,
  waitForSupervisorReady,
  waitForWorkerExit,
  workerConnectTimeoutMs,
  workerStopGraceMs,
} from "./supervisor-process.js";
import { handleWorkerRequest } from "./supervisor-requests.js";
import type { ActiveRequest, InboundWaitHandler, ToolCallHandler } from "./supervisor-types.js";

export type {
  InboundWaitParams,
  InboundWaitResult,
  ToolCallContext,
  ToolCallParams,
  ToolCallResult,
} from "./supervisor-types.js";

/** Construction config (#462 §3 — the 7-positional constructor is gone). */
export type WorkerSupervisorOptions = {
  id: number;
  script: string;
  // The event sink is required on purpose: a defaulted no-op would
  // silently swallow Operational.Events.Warn — the exact failure mode the
  // ledger exists to prevent (#477 review W3).
  events: BusEvent.Sink;
  socketDir?: string;
  bootstrap?: WorkerBootstrap.Bootstrap;
  toolRelay?: ToolCallHandler;
  inboundWait?: InboundWaitHandler;
  /**
   * Extra env keys forwarded to the worker on top of the production
   * allowlist. A test seam: fixtures pass their OPENOMNI_WORKER_* knobs here
   * instead of the knobs sitting in the default every production worker gets.
   */
  extraEnvKeys?: readonly string[];
};

export class WorkerSupervisor {
  private proc: Subprocess | null = null;
  private client: IpcClient | null = null;
  private bootstrapped = false;
  private readonly authToken = crypto.randomUUID();
  private consecutiveFastCrashes = 0;
  private lastSpawnAt = 0;
  private generationBecameReady = false;
  private generation = 0;
  // One trace per worker generation: minted at spawn (Owner-gated ring-2 mint,
  // see #606 D11 remainder) and shared by every lifecycle event of that
  // generation — Spawned/Ready/Exited and generation-scoped warns.
  private generationTraceId = "";
  private running = false;
  private stopping = false;
  private readonly activeToolCalls = new Map<string, ActiveRequest>();
  private readonly activeInboundWaitCalls = new Map<string, ActiveRequest>();
  readonly socketPath: string;

  readonly id: number;
  private readonly script: string;
  private readonly events: BusEvent.Sink;
  private readonly bootstrap?: WorkerBootstrap.Bootstrap;
  private readonly toolRelay?: ToolCallHandler;
  private readonly inboundWait?: InboundWaitHandler;
  private readonly extraEnvKeys: readonly string[];

  constructor(options: WorkerSupervisorOptions) {
    this.id = options.id;
    this.script = options.script;
    this.events = options.events;
    this.bootstrap = options.bootstrap;
    this.toolRelay = options.toolRelay;
    this.inboundWait = options.inboundWait;
    this.extraEnvKeys = options.extraEnvKeys ?? [];
    this.socketPath = `${options.socketDir ?? "/tmp"}/openomni-worker-${options.id}.sock`;
    this.doStart();
  }

  private doStart(): void {
    this.generation += 1;
    this.generationTraceId = crypto.randomUUID();
    this.running = true;
    this.bootstrapped = false;
    this.lastSpawnAt = Date.now();
    this.generationBecameReady = false;
    this.proc = Bun.spawn(
      ["bun", this.script, "--", "--worker-id", String(this.id), "--socket", this.socketPath],
      {
        env: {
          ...buildWorkerEnv(process.env, this.extraEnvKeys),
          OPENOMNI_WORKER_IPC_TOKEN: this.authToken,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const generation = this.generation;
    this.events.publish(Worker.Events.Spawned, {
      traceId: this.generationTraceId,
      time: Date.now(),
      workerId: this.id,
      generation,
    });
    this.proc.exited.then(() => {
      this.running = false;
      this.bootstrapped = false;
      const prev = this.client;
      this.client = null;
      prev?.close();
      this.events.publish(Worker.Events.Exited, {
        traceId: this.generationTraceId,
        time: Date.now(),
        workerId: this.id,
        generation,
        planned: this.stopping,
      });
      if (!this.stopping) this.scheduleRestart();
    });
    void this.connectWithRetry();
  }

  private async connectWithRetry(): Promise<void> {
    // Snapshot THIS generation's trace: the settled-notification closure (and
    // the deadline warn below) can fire after a crash re-minted the field —
    // a warn for generation N must not file under N+1's trace.
    const generationTraceId = this.generationTraceId;
    // Snapshot THIS generation too: `this.running` is live state, so a gen-N
    // loop that survived a crash-restart would otherwise read gen-N+1's
    // `running = true`, bootstrap the new generation's socket a second time,
    // and overwrite `this.client` alongside the real gen-N+1 loop.
    const generation = this.generation;
    const deadline = Date.now() + workerConnectTimeoutMs();
    let lastError: Error | null = null;
    const bootstrap = this.bootstrap;
    const authToken = this.authToken;

    while (
      Date.now() < deadline &&
      !this.stopping &&
      this.running &&
      this.generation === generation
    ) {
      if (!fs.existsSync(this.socketPath)) {
        await new Promise<void>((r) => setTimeout(r, 250));
        continue;
      }
      let attemptClient: Awaited<ReturnType<typeof connectIpcClient>> | undefined;
      try {
        const c = await connectIpcClient(this.socketPath, {
          connectTimeoutMs: 500,
          onRequest: (method, params, respond) => {
            handleWorkerRequest(method, params, respond, {
              authToken,
              workerId: this.id,
              activeToolCalls: this.activeToolCalls,
              activeInboundWaitCalls: this.activeInboundWaitCalls,
              toolCallHandler: this.toolRelay,
              inboundWaitHandler: this.inboundWait,
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
                    // Ledger, not console: swallowing this into stdout is the
                    // exact failure mode the injected sink exists to prevent.
                    this.events.publish(Operational.Events.Warn, {
                      traceId: generationTraceId,
                      time: Date.now(),
                      component: "coordinator",
                      msg: "worker.tool_call_settled notification failed",
                      context: {
                        callId,
                        ...(workspaceRoot ? { workspaceRoot } : {}),
                        error: err instanceof Error ? err.message : String(err),
                      },
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
        attemptClient = c;
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
        if (!this.stopping && this.running && this.generation === generation) {
          this.client = c;
          this.generationBecameReady = true;
          this.events.publish(Worker.Events.Ready, {
            traceId: generationTraceId,
            time: Date.now(),
            workerId: this.id,
            generation,
          });
        } else {
          // Stale (stopped, crashed, or superseded by a newer generation):
          // installing this client would hand gen-N's bootstrap the socket
          // gen-N+1's loop owns. Close what we just created and bail.
          c.close();
        }
        return;
      } catch (error) {
        // A failed attempt must not leak its connected client: a stale one
        // keeps live onRequest/onNotification handlers and can flip
        // `bootstrapped` or answer worker requests alongside the winner.
        attemptClient?.close();
        lastError = error instanceof Error ? error : new Error(String(error));
        await new Promise<void>((r) => setTimeout(r, 100));
      }
    }

    if (!this.stopping && this.running && this.generation === generation) {
      // doStart() fires this promise without awaiting it, so a throw here would
      // surface as an unhandled rejection; report on the ledger instead.
      this.events.publish(Operational.Events.Warn, {
        traceId: generationTraceId,
        time: Date.now(),
        component: "coordinator.worker",
        msg: "worker IPC connect failed within deadline; killing worker",
        context: {
          workerId: this.id,
          error: lastError?.message ?? "worker never served its IPC socket",
        },
      });
      // Zombie prevention (#audit H1): a process that spawned but never served
      // IPC (or rejected bootstrap every attempt) used to linger with
      // running=true and isReady()=false — ensureSupervisor kept re-arming it
      // and every delivery re-reset the slot's idle timer, wedging the slot
      // forever. Kill it so the exited → scheduleRestart path (and, once the
      // crash-loop breaker trips, ensureSupervisor replacement) takes over.
      this.forceKill();
    }
  }

  private scheduleRestart(): void {
    // Real circuit breaker (#audit M2): the old 60s window was arithmetically
    // unreachable — the backoff delays alone (1+2+4+8+16+30s) exceeded it, so
    // the count reset before ever crossing the threshold and an
    // instantly-crashing worker respawned forever. Count consecutive fast
    // crashes instead: a generation that became ready AND survived
    // FAST_CRASH_THRESHOLD_MS proves the script can run and starts a fresh
    // burst; MAX_CONSECUTIVE_FAST_CRASHES fast crashes in a row trip the
    // breaker and restarts stop (terminal warn below — the next delivery
    // replaces this supervisor explicitly through ensureSupervisor).
    const uptimeMs = Date.now() - this.lastSpawnAt;
    const provedHealthy = this.generationBecameReady && uptimeMs >= FAST_CRASH_THRESHOLD_MS;
    this.consecutiveFastCrashes = provedHealthy ? 1 : this.consecutiveFastCrashes + 1;
    if (this.consecutiveFastCrashes > MAX_CONSECUTIVE_FAST_CRASHES) {
      this.events.publish(Operational.Events.Warn, {
        traceId: this.generationTraceId,
        time: Date.now(),
        component: "coordinator.worker",
        msg: "worker is crash-looping; restarts suspended",
        context: {
          workerId: this.id,
          consecutiveFastCrashes: this.consecutiveFastCrashes,
          fastCrashThresholdMs: FAST_CRASH_THRESHOLD_MS,
        },
      });
      return;
    }

    const delayMs = resolveRestartDelay(this.consecutiveFastCrashes);
    this.events.publish(Worker.Events.Restarted, {
      traceId: this.generationTraceId,
      time: Date.now(),
      workerId: this.id,
      restartCount: this.consecutiveFastCrashes,
      delayMs,
    });
    setTimeout(() => {
      if (!this.stopping) this.doStart();
    }, delayMs);
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
    return waitForSupervisorReady(
      this.id,
      () => this.isReady(),
      timeoutMs,
      () => this.stopping,
    );
  }

  // The three worker RPCs live here directly (#462 §3 — supervisor-client.ts
  // was three thin wrappers around this.client with no second consumer).
  async deliver(
    runId: string,
    task: Record<string, unknown> & { readonly traceId: string },
  ): Promise<unknown> {
    const client = this.client;
    const sessionId = typeof task.sessionId === "string" ? task.sessionId : undefined;
    if (!client?.connected) {
      throw new WorkerDeliveryError({
        message: `worker ${this.id} not available`,
        code: "worker_unavailable",
        runId,
        sessionId,
      });
    }
    const timeoutMs = resolveDeliverTimeoutMs(task);
    try {
      return await client.call(
        "coordinator.spawn_run",
        { authToken: this.authToken, runId, ...task },
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof IpcTimeoutError) {
        // Wall-time physics (#462 §4): the run outlived its ceiling, so the
        // process dies regardless of what the agent loop inside is doing —
        // runaway runs are killed before policy ever sees anything. The kill
        // triggers the normal exited → restart path for the slot.
        this.events.publish(Operational.Events.Warn, {
          // The kill is an event OF the run — the same trace its
          // RunSettled{interrupted} carries (D11). The type requires the
          // trace the pool's normalizer already refused to go without; no
          // fallback exists because none is reachable.
          traceId: task.traceId,
          time: Date.now(),
          component: "coordinator.worker",
          msg: "run exceeded wall-time ceiling; killing worker",
          context: { workerId: this.id, runId, timeoutMs },
        });
        this.forceKill();
        throw new WorkerDeliveryError({
          message: `run ${runId} exceeded wall-time ceiling of ${timeoutMs}ms`,
          code: "wall_time_exceeded",
          runId,
          sessionId,
        });
      }
      if (error instanceof IpcConnectionError) {
        // Typed-rejection contract (#audit M6): the transport error must not
        // leak raw across the driver surface — callers branch on data.code.
        throw new WorkerDeliveryError(
          {
            message: `worker ${this.id} IPC connection lost during run ${runId}: ${error.message}`,
            code: "ipc_connection_lost",
            runId,
            sessionId,
          },
          { cause: error },
        );
      }
      throw error;
    }
  }

  async cancel(runId: string, sessionId: string): Promise<unknown> {
    const client = this.client;
    if (!client?.connected) {
      return { cancelled: false, error: `worker ${this.id} not available` };
    }
    return client.call(
      "coordinator.cancel_run",
      { authToken: this.authToken, runId, sessionId },
      5_000,
    );
  }

  async send(
    sessionId: string,
    message: string,
    traceId: string,
    runId?: string,
  ): Promise<unknown> {
    const client = this.client;
    if (!client?.connected) {
      return { accepted: false, error: `worker ${this.id} not available` };
    }
    return client.call(
      "worker.deliver_message",
      { authToken: this.authToken, traceId, sessionId, ...(runId ? { runId } : {}), message },
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
    if (this.proc && this.running) this.proc.kill("SIGKILL");
  }

  /** Kill without restart — for discarding a worker no slot references anymore. */
  dispose(): void {
    this.stopping = true;
    const c = this.client;
    this.client = null;
    c?.close();
    this.forceKill();
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
        this.events.publish(Operational.Events.Warn, {
          traceId: this.generationTraceId,
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

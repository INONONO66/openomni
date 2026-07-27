import fs from "node:fs";
import type { Subprocess } from "bun";
import {
  type BusEvent,
  Ipc,
  Operational,
  WorkerDeliveryError,
  WorkerDriver,
} from "@openomni/protocol";
import { connectIpcClient, type IpcClient } from "../ipc/client";
import { IpcTimeoutError } from "../ipc/errors";
import {
  createGenerationSocketPath,
  createSupervisorSocketDir,
} from "../worker-manager/worker-socket-dir.js";
import {
  buildWorkerEnv,
  closeWorkerPrivatePipe,
  createWorkerGenerationKey,
  createWorkerBootstrapChallenge,
  createWorkerGenerationKeySigner,
  type WorkerGenerationKeySigner,
  isBootstrapAccepted,
  isShutdownAcknowledged,
  resolveDeliverTimeoutMs,
  resolveRestartDelay,
  waitForSupervisorReady,
  waitForWorkerExit,
  isWorkerBootstrapProof,
  workerBootstrapProof,
  workerGenerationToken,
  workerStopGraceMs,
  writeWorkerGenerationKey,
  writeWorkerPrivateFrame,
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

export type WorkerKernelTransitionRequestV1 = Ipc.WorkerKernelTransitionRequestV1;
export type WorkerKernelQueryRequestV1 = Ipc.WorkerKernelQueryRequestV1;
export type WorkerObservationV1 = Ipc.WorkerObservationV1;
export type CredentialProvisioningFrameV1 = Ipc.CredentialProvisioningFrameV1;
export type WorkerRuntimeBinding = Readonly<{
  runtimeId: string;
  workerId: string;
  generation: number;
  principalId: string;
  processId: number;
}>;
export type WorkerRuntimeDeliveryTask = Readonly<{
  runId: string;
  sessionId: string;
  prompt: string;
}>;
export type WorkerRuntimeDefinitionPort = (
  binding: WorkerRuntimeBinding,
  task: WorkerRuntimeDeliveryTask,
) => Promise<Ipc.WorkerRuntimeDefinitionV1>;

export type CredentialProvisioningReceiptV1 = Ipc.CredentialProvisioningReceiptV1;
export type CredentialProvisioningPortResultV1 = Ipc.CredentialProvisioningPortResultV1;
export interface WorkerKernelChannelIdentityV1 {
  readonly runtimeId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly principalId: string;
  readonly processId: number;
  readonly attempt: Ipc.WorkerRuntimeDefinitionV1["attempt"];
}
export type WorkerKernelTransitionPort = (frame: {
  readonly channelIdentity: WorkerKernelChannelIdentityV1;
  readonly request: Omit<Ipc.WorkerKernelTransitionRequestV1, "authToken">;
}) => Promise<Ipc.WorkerKernelTransitionResultV1>;
export type WorkerKernelQueryPort = (frame: {
  readonly channelIdentity: WorkerKernelChannelIdentityV1;
  readonly request: Omit<Ipc.WorkerKernelQueryRequestV1, "authToken">;
}) => Promise<Ipc.WorkerKernelQueryResultV1>;
export type WorkerObservationPort = (event: Ipc.WorkerObservationV1) => Promise<void>;
export type WorkerCredentialProvisioningSigner = WorkerGenerationKeySigner;
export type WorkerCredentialProvisioningPort = (
  frame: Ipc.CredentialProvisioningFrameV1,
  signer?: WorkerCredentialProvisioningSigner,
) => Promise<Ipc.CredentialProvisioningPortResultV1>;

export type WorkerBootstrapConfig = Readonly<Record<string, unknown>> & {
  readonly configEpoch: string;
  readonly credentials?: never;
};

/** Construction config (#462 §3 — the 7-positional constructor is gone). */
export type WorkerSupervisorOptions = {
  id: number;
  script: string;
  runtimeId?: string;
  principalId?: string;
  // The event sink is required on purpose: a defaulted no-op would
  // silently swallow Operational.Warn — the exact failure mode the
  // ledger exists to prevent (#477 review W3).
  events: BusEvent.Sink;
  socketDir?: string;
  bootstrap?: WorkerBootstrapConfig;
  toolRelay?: ToolCallHandler;
  inboundWait?: InboundWaitHandler;
  kernelTransition?: WorkerKernelTransitionPort;
  kernelQuery?: WorkerKernelQueryPort;
  observation?: WorkerObservationPort;
  provisionCredentials?: WorkerCredentialProvisioningPort;
  runtimeDefinition: WorkerRuntimeDefinitionPort;
};

export class WorkerSupervisor {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private client: IpcClient | null = null;
  private bootstrapped = false;
  private authToken = "";
  private restartCount = 0;
  private restartWindowStart = 0;
  private generation = 0;
  private running = false;
  private stopping = false;
  private readonly activeToolCalls = new Map<string, ActiveRequest>();
  private readonly activeInboundWaitCalls = new Map<string, ActiveRequest>();
  private readonly activeRuntimeDefinitions = new Map<
    string,
    Readonly<{ runtime: Ipc.WorkerRuntimeDefinitionV1; sessionId: string }>
  >();
  private generationKey: Uint8Array | null = null;
  private activeProvisioningSigner: WorkerGenerationKeySigner | null = null;
  private readonly supervisorSocketDir: string;
  private currentSocketPath: string;

  readonly id: number;
  private readonly script: string;
  private readonly events: BusEvent.Sink;
  private readonly runtimeId?: string;
  private readonly principalId?: string;
  private readonly bootstrap?: WorkerBootstrapConfig;
  private readonly toolRelay?: ToolCallHandler;
  private readonly inboundWait?: InboundWaitHandler;
  private readonly kernelTransition?: WorkerKernelTransitionPort;
  private readonly kernelQuery?: WorkerKernelQueryPort;
  private readonly observation?: WorkerObservationPort;
  private readonly provisionCredentials?: WorkerCredentialProvisioningPort;
  private readonly runtimeDefinition: WorkerRuntimeDefinitionPort;

  constructor(options: WorkerSupervisorOptions) {
    if (options.bootstrap?.credentials !== undefined) {
      throw new TypeError("worker bootstrap must not contain credential material");
    }
    this.id = options.id;
    this.script = options.script;
    this.events = options.events;
    this.runtimeId = options.runtimeId;
    this.principalId = options.principalId;
    this.bootstrap = options.bootstrap;
    this.toolRelay = options.toolRelay;
    this.inboundWait = options.inboundWait;
    this.kernelTransition = options.kernelTransition;
    this.kernelQuery = options.kernelQuery;
    this.observation = options.observation;
    this.provisionCredentials = options.provisionCredentials;
    this.runtimeDefinition = options.runtimeDefinition;
    this.supervisorSocketDir = createSupervisorSocketDir(options.socketDir ?? "/tmp", options.id);
    this.currentSocketPath = createGenerationSocketPath(this.supervisorSocketDir);
    this.doStart();
  }

  get socketPath(): string {
    return this.currentSocketPath;
  }

  private doStart(): void {
    this.generationKey?.fill(0);
    this.generationKey = null;
    this.activeProvisioningSigner?.dispose();
    this.activeProvisioningSigner = null;
    this.generation += 1;
    this.running = true;
    this.bootstrapped = false;
    fs.rmSync(this.currentSocketPath, { force: true });
    this.currentSocketPath = createGenerationSocketPath(this.supervisorSocketDir);
    const generationKey = createWorkerGenerationKey();
    this.generationKey = generationKey;
    this.authToken = workerGenerationToken(generationKey);
    const socketPath = this.currentSocketPath;
    const proc = Bun.spawn(
      ["bun", this.script, "--", "--worker-id", String(this.id), "--socket", socketPath],
      {
        env: buildWorkerEnv(process.env),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    this.proc = proc;
    try {
      writeWorkerGenerationKey(proc, generationKey.slice());
    } catch (error) {
      generationKey.fill(0);
      this.generationKey = null;
      proc.kill("SIGKILL");
      throw error;
    }
    const generation = this.generation;
    this.events.publish(WorkerDriver.Spawned, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      workerId: this.id,
      generation,
    });
    this.proc.exited.then(() => {
      const isCurrentGeneration = generation === this.generation && proc === this.proc;
      if (isCurrentGeneration) {
        this.running = false;
        this.bootstrapped = false;
        this.activeProvisioningSigner?.dispose();
        this.activeProvisioningSigner = null;
        const prev = this.client;
        this.client = null;
        prev?.close();
        this.authToken = "";
        this.generationKey?.fill(0);
        this.generationKey = null;
      }
      closeWorkerPrivatePipe(proc);
      this.events.publish(WorkerDriver.Exited, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        workerId: this.id,
        generation,
        planned: this.stopping,
      });
      if (isCurrentGeneration && !this.stopping) this.scheduleRestart();
    });
    void this.connectWithRetry(generation, proc, socketPath);
  }

  private async connectWithRetry(
    generation: number,
    proc: Subprocess,
    socketPath: string,
  ): Promise<void> {
    const deadline = Date.now() + WORKER_CONNECT_TIMEOUT_MS;
    let lastError: Error | null = null;
    const bootstrap = this.bootstrap;
    const authToken = this.authToken;
    let credentialProvisioningState: Parameters<
      typeof handleWorkerRequest
    >[3]["credentialProvisioningState"] = "available";
    let pendingCredentialProvisioning: Parameters<
      typeof handleWorkerRequest
    >[3]["pendingCredentialProvisioning"];
    // Connect directly after a short spawn allowance. Retrying the connect itself
    // is authoritative; no pathname existence probe is used as a security check.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    while (
      Date.now() < deadline &&
      !this.stopping &&
      this.running &&
      generation === this.generation &&
      proc === this.proc
    ) {
      const challenge = createWorkerBootstrapChallenge();
      const proofContext = {
        runtimeId: this.runtimeId,
        workerId: String(this.id),
        generation,
      };
      const requestProof = workerBootstrapProof(authToken, challenge, "request", proofContext);
      const bootstrapCredential = `${challenge}.${requestProof}`;
      const readyProof = workerBootstrapProof(authToken, challenge, "ready", proofContext);
      let candidate: IpcClient | null = null;
      let responseAuthenticated = false;
      let readyAuthenticated = false;
      let resolveReady: (() => void) | undefined;
      const readyReceived = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      try {
        candidate = await connectIpcClient(socketPath, {
          connectTimeoutMs: 500,
          onRequest: (method, params, respond) => {
            handleWorkerRequest(method, params, respond, {
              authToken,
              runtimeId: this.runtimeId,
              principalId: this.principalId,
              workerId: this.id,
              generation,
              // Bun on Darwin does not expose Unix peer credentials. Trust comes
              // from the supervisor-owned 0700 pathname capability plus the
              // generation-key bootstrap proof. This is the PID of the child we
              // launched, retained as binding metadata; it is not peer-PID proof.
              processId: proc.pid,
              isChannelAuthenticated: () =>
                responseAuthenticated &&
                readyAuthenticated &&
                candidate !== null &&
                candidate === this.client &&
                candidate.connected &&
                generation === this.generation &&
                proc === this.proc,
              activeToolCalls: this.activeToolCalls,
              activeInboundWaitCalls: this.activeInboundWaitCalls,
              toolCallHandler: this.toolRelay,
              inboundWaitHandler: this.inboundWait,
              kernelTransition: this.kernelTransition,
              kernelQuery: this.kernelQuery,
              observation: this.observation,
              provisionCredentials: this.provisionCredentials,
              runtimeForRun: (runId, sessionId) => {
                const active = this.activeRuntimeDefinitions.get(runId);
                return active?.sessionId === sessionId ? active.runtime : undefined;
              },
              takeProvisioningSigner: (attempt) => {
                if (
                  !this.runtimeId ||
                  !this.principalId ||
                  generation !== this.generation ||
                  proc !== this.proc ||
                  !this.running
                ) {
                  throw new Error("worker generation key unavailable");
                }
                const key = this.generationKey;
                if (key === null) throw new Error("worker generation key unavailable");
                this.generationKey = null;
                const signer = createWorkerGenerationKeySigner(key, {
                  runtimeId: this.runtimeId,
                  workerId: String(this.id),
                  generation,
                  principalId: this.principalId,
                  attempt: Object.freeze({ ...attempt }),
                  processId: proc.pid,
                });
                this.activeProvisioningSigner = signer;
                return signer;
              },
              releaseProvisioningSigner: (signer) => {
                if (this.activeProvisioningSigner === signer) {
                  signer.dispose();
                  this.activeProvisioningSigner = null;
                }
              },
              writePrivateFrame: (frame) => {
                if (
                  this.stopping ||
                  generation !== this.generation ||
                  proc !== this.proc ||
                  !this.running
                ) {
                  frame.fill(0);
                  throw new Error("worker generation stopped before credential provisioning");
                }
                writeWorkerPrivateFrame(proc, frame);
              },
              get credentialProvisioningState() {
                return credentialProvisioningState;
              },
              set credentialProvisioningState(value) {
                credentialProvisioningState = value;
              },
              get pendingCredentialProvisioning() {
                return pendingCredentialProvisioning;
              },
              set pendingCredentialProvisioning(value) {
                pendingCredentialProvisioning = value;
              },
            });
          },
          onNotification: (method, params) => {
            if (
              method === "worker.bootstrap_ready" &&
              isWorkerBootstrapProof(params?.authToken, readyProof) &&
              params?.runtimeId === proofContext.runtimeId &&
              params?.workerId === proofContext.workerId &&
              params?.generation === generation &&
              generation === this.generation &&
              proc === this.proc
            ) {
              readyAuthenticated = true;
              resolveReady?.();
            }
          },
        });
        if (candidate === null) throw new Error("worker IPC connection unavailable");
        const bootstrapResult = await candidate.call(
          "coordinator.bootstrap",
          {
            authToken: bootstrapCredential,
            runtimeId: this.runtimeId,
            workerId: String(this.id),
            generation,
            configEpoch: bootstrap?.configEpoch,
          },
          5000,
        );
        if (!isBootstrapAccepted(bootstrapResult)) {
          throw new Error("worker bootstrap rejected");
        }
        responseAuthenticated = true;
        if (!readyAuthenticated) {
          const readyTimeoutMs = Math.min(1_000, Math.max(1, deadline - Date.now()));
          let readyTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              readyReceived,
              new Promise<never>((_, reject) => {
                readyTimer = setTimeout(
                  () => reject(new Error("worker bootstrap_ready not received")),
                  readyTimeoutMs,
                );
              }),
            ]);
          } finally {
            if (readyTimer) clearTimeout(readyTimer);
          }
        }
        if (
          generation !== this.generation ||
          proc !== this.proc ||
          this.stopping ||
          !this.running ||
          !candidate.connected ||
          !responseAuthenticated ||
          !readyAuthenticated
        ) {
          candidate.close();
          return;
        }
        this.client = candidate;
        this.bootstrapped = true;
        this.events.publish(WorkerDriver.Ready, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          workerId: this.id,
          generation: this.generation,
        });
        return;
      } catch (error) {
        candidate?.close();
        lastError = error instanceof Error ? error : new Error(String(error));
        await new Promise<void>((r) => setTimeout(r, 100));
      }
    }

    if (!this.stopping && this.running && lastError) {
      // doStart() fires this promise without awaiting it, so a throw here would
      // surface as an unhandled rejection; report and let waitReady() time out.
      this.events.publish(Operational.Warn, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "coordinator.worker",
        msg: "worker IPC connect failed within deadline",
        context: { workerId: this.id, error: lastError.message },
      });
    }
  }

  private scheduleRestart(): void {
    const now = Date.now();
    if (now - this.restartWindowStart > RESTART_WINDOW_MS) {
      this.restartCount = 0;
      this.restartWindowStart = now;
    }
    this.restartCount++;

    const delayMs = resolveRestartDelay(this.restartCount);
    this.events.publish(WorkerDriver.Restarted, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      workerId: this.id,
      restartCount: this.restartCount,
      delayMs,
    });
    setTimeout(() => {
      if (!this.stopping) this.doStart();
    }, delayMs);
  }

  isActive(): boolean {
    return this.running;
  }

  private readyClient(): IpcClient | null {
    const client = this.client;
    return client?.connected === true && this.bootstrapped && this.running && this.proc !== null
      ? client
      : null;
  }

  isReady(): boolean {
    return this.readyClient() !== null;
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
    task: Record<string, unknown>,
  ): Promise<Ipc.CoordinatorSpawnRunResultV1> {
    const client = this.readyClient();
    if (!client) {
      throw new Error(`worker ${this.id} not available`);
    }
    if (typeof this.runtimeDefinition !== "function") {
      throw new Error("worker runtime definition port is required");
    }
    const runtimeId = this.runtimeId;
    const principalId = this.principalId;
    const proc = this.proc;
    const generation = this.generation;
    if (!runtimeId || !principalId || !proc || !this.running) {
      throw new Error(`worker ${this.id} runtime binding is unavailable`);
    }
    if (typeof task.sessionId !== "string" || !task.sessionId || typeof task.prompt !== "string") {
      throw new TypeError("worker delivery requires primitive sessionId and prompt fields");
    }
    const deliveryTask: WorkerRuntimeDeliveryTask = Object.freeze({
      runId,
      sessionId: task.sessionId,
      prompt: task.prompt,
    });
    const binding: WorkerRuntimeBinding = Object.freeze({
      runtimeId,
      workerId: String(this.id),
      generation,
      principalId,
      processId: proc.pid,
    });
    const timeoutMs = resolveDeliverTimeoutMs(task);
    const providedRuntime = Ipc.WorkerRuntimeDefinitionV1.parse(
      await this.runtimeDefinition(binding, deliveryTask),
    );
    if (
      providedRuntime.runtimeId !== binding.runtimeId ||
      providedRuntime.workerId !== binding.workerId ||
      providedRuntime.generation !== binding.generation ||
      providedRuntime.principalId !== binding.principalId
    ) {
      throw new Error("runtime definition identity does not match worker process binding");
    }
    if (
      proc !== this.proc ||
      generation !== this.generation ||
      !this.running ||
      client !== this.readyClient()
    ) {
      throw new Error("worker process changed while composing runtime definition");
    }
    const runtime = Ipc.WorkerRuntimeDefinitionV1.parse({
      ...providedRuntime,
      runtimeId: binding.runtimeId,
      workerId: binding.workerId,
      generation: binding.generation,
      principalId: binding.principalId,
    });
    const activeRuntime = Object.freeze({ runtime, sessionId: deliveryTask.sessionId });
    this.activeRuntimeDefinitions.set(runId, activeRuntime);
    try {
      return Ipc.Methods["coordinator.spawn_run"].result.parse(
        await client.call(
          "coordinator.spawn_run",
          {
            authToken: this.authToken,
            runId: deliveryTask.runId,
            sessionId: deliveryTask.sessionId,
            prompt: deliveryTask.prompt,
            runtime,
          },
          timeoutMs,
        ),
      );
    } catch (error) {
      if (error instanceof IpcTimeoutError) {
        this.events.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
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
          sessionId: typeof task.sessionId === "string" ? task.sessionId : undefined,
        });
      }
      throw error;
    } finally {
      if (this.activeRuntimeDefinitions.get(runId) === activeRuntime) {
        this.activeRuntimeDefinitions.delete(runId);
      }
    }
  }

  async cancel(runId: string, sessionId: string): Promise<unknown> {
    const client = this.readyClient();
    if (!client) {
      return { cancelled: false, error: `worker ${this.id} not available` };
    }
    return client.call(
      "coordinator.cancel_run",
      { authToken: this.authToken, runId, sessionId },
      5_000,
    );
  }

  async send(sessionId: string, message: string, runId?: string): Promise<unknown> {
    const client = this.readyClient();
    if (!client) {
      return { accepted: false, error: `worker ${this.id} not available` };
    }
    return client.call(
      "worker.deliver_message",
      { authToken: this.authToken, sessionId, ...(runId ? { runId } : {}), message },
      5_000,
    );
  }

  async shutdownIdle(): Promise<boolean> {
    const c = this.readyClient();
    if (!c) {
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
    this.generationKey?.fill(0);
    this.generationKey = null;
    this.activeProvisioningSigner?.dispose();
    this.activeProvisioningSigner = null;
    const c = this.client;
    this.client = null;
    this.bootstrapped = false;
    c?.close();
    if (this.proc) closeWorkerPrivatePipe(this.proc);
    this.forceKill();
    fs.rmSync(this.supervisorSocketDir, { recursive: true, force: true });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.generationKey?.fill(0);
    this.generationKey = null;
    this.activeProvisioningSigner?.dispose();
    this.activeProvisioningSigner = null;
    const c = this.client;
    this.client = null;
    this.bootstrapped = false;
    c?.close();
    if (this.proc) closeWorkerPrivatePipe(this.proc);
    const proc = this.proc;
    if (proc && this.running) {
      proc.kill("SIGTERM");
      const graceMs = workerStopGraceMs();
      if ((await waitForWorkerExit(proc, graceMs)) === "timeout") {
        this.events.publish(Operational.Warn, {
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
    this.authToken = "";
    fs.rmSync(this.supervisorSocketDir, { recursive: true, force: true });
  }
}

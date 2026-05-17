import { ChatAgent, type ChatAgentConfig, type ChatAgentInput } from "@openomni/agent";
import {
  IngressEvent,
  type Ingress,
  type Tool,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { buildWorkerMiddleware } from "../execution-runtime/middleware";
import { SessionBridge } from "../ingress/session-bridge";

export type ResidentLifecycle = "sleeping" | "hydrating" | "active" | "idle" | "releasing";

export interface ResidentRunContext {
  readonly sessionId: string;
  readonly event: Ingress.ResolvedInboundEvent;
  readonly traceContext?: TraceContextProtocol.Type;
}

export interface ResidentRunResult {
  readonly output: string;
  readonly finishReason: string;
  readonly runId: string;
  readonly activationId: string;
}

export interface ResidentRuntimeOptions {
  readonly maxActive?: number;
  readonly idleTimeoutMs?: number;
  readonly slotWaitTimeoutMs?: number;
  readonly runAgent?: (
    config: ChatAgentConfig,
    input: ChatAgentInput,
  ) => Promise<{
    text: string;
    finishReason: string;
  }>;
}

interface ActivationRecord {
  activationId: string;
  lifecycle: ResidentLifecycle;
  idleTimer?: ReturnType<typeof setTimeout>;
  queue: Promise<unknown>;
  lastUsedAt: number;
}

type SlotWaiter = { resolve: () => void; reject: (error: Error) => void };

function defaultRunAgent(config: ChatAgentConfig, input: ChatAgentInput) {
  return ChatAgent.create(config).run(input);
}

function extractAgentName(event: Ingress.ResolvedInboundEvent): string | undefined {
  const raw = event.meta?.agentName ?? event.meta?.agent;
  return typeof raw === "string" ? raw : undefined;
}

export class ResidentRuntime {
  private readonly activations = new Map<string, ActivationRecord>();
  private readonly waiters: SlotWaiter[] = [];
  private readonly maxActive: number;
  private readonly idleTimeoutMs: number;
  private readonly slotWaitTimeoutMs: number;
  private activeRuns = 0;
  private readonly runAgent: NonNullable<ResidentRuntimeOptions["runAgent"]>;

  constructor(options: ResidentRuntimeOptions = {}) {
    this.maxActive = options.maxActive ?? 10;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.slotWaitTimeoutMs = options.slotWaitTimeoutMs ?? 30_000;
    this.runAgent = options.runAgent ?? defaultRunAgent;
  }

  stats(): { activations: number; activeRuns: number; idle: number; maxActive: number } {
    let idle = 0;
    for (const activation of this.activations.values()) {
      if (activation.lifecycle === "idle") idle++;
    }
    return {
      activations: this.activations.size,
      activeRuns: this.activeRuns,
      idle,
      maxActive: this.maxActive,
    };
  }

  getLifecycle(sessionId: string): ResidentLifecycle {
    return this.activations.get(sessionId)?.lifecycle ?? "sleeping";
  }

  release(sessionId: string): void {
    const activation = this.activations.get(sessionId);
    if (!activation) return;
    activation.lifecycle = "releasing";
    if (activation.idleTimer) clearTimeout(activation.idleTimer);
    this.activations.delete(sessionId);
  }

  async run(ctx: ResidentRunContext): Promise<ResidentRunResult> {
    const activation = this.ensureActivation(ctx.sessionId);
    const previous = activation.queue;
    const chained = previous.catch(() => undefined).then(() => this.runExclusive(ctx));
    activation.queue = chained;
    return chained;
  }

  private ensureActivation(sessionId: string): ActivationRecord {
    let activation = this.activations.get(sessionId);
    if (!activation) {
      this.evictIdleActivations();
      if (this.activations.size >= this.maxActive) {
        throw new Error(`maximum resident activations reached (${this.maxActive})`);
      }
      activation = {
        activationId: crypto.randomUUID(),
        lifecycle: "sleeping",
        queue: Promise.resolve(),
        lastUsedAt: Date.now(),
      };
      this.activations.set(sessionId, activation);
    }
    return activation;
  }

  private evictIdleActivations(): void {
    for (const [sessionId, activation] of this.activations.entries()) {
      if (this.activations.size < this.maxActive) return;
      if (activation.lifecycle === "idle" || activation.lifecycle === "sleeping") {
        this.release(sessionId);
      }
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeRuns < this.maxActive) {
      this.activeRuns++;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(
          new Error(`resident activation slot wait timed out after ${this.slotWaitTimeoutMs}ms`),
        );
      }, this.slotWaitTimeoutMs);
    });
    if (timer) clearTimeout(timer);
  }

  private releaseSlot(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve();
      return;
    }
    this.activeRuns = Math.max(0, this.activeRuns - 1);
  }

  private scheduleIdleRelease(sessionId: string, activation: ActivationRecord): void {
    if (activation.idleTimer) clearTimeout(activation.idleTimer);
    activation.lifecycle = "idle";
    activation.idleTimer = setTimeout(() => {
      const current = this.activations.get(sessionId);
      if (current === activation && current.lifecycle === "idle") this.release(sessionId);
    }, this.idleTimeoutMs);
  }

  private buildAgentConfig(ctx: ResidentRunContext, runId: string): ChatAgentConfig {
    const workspaceRoot = ctx.event.agent.toolConfig?.workspaceRoot ?? ctx.event.workspace;
    const toolExecutor = ctx.event.agent.toolExecutorFactory
      ? ctx.event.agent.toolExecutorFactory({
          sessionId: ctx.sessionId,
          runId,
          agentName: extractAgentName(ctx.event),
          workspaceRoot,
        })
      : ctx.event.agent.toolExecutor;

    return {
      model: ctx.event.agent.model,
      systemPrompt: ctx.event.agent.systemPrompt,
      budget: ctx.event.agent.budget,
      tools: ctx.event.agent.tools,
      permissions: ctx.event.agent.permissions,
      toolExecutor: toolExecutor as ((call: Tool.Call) => Promise<Tool.Result>) | undefined,
      middleware: buildWorkerMiddleware({
        permissions: ctx.event.agent.permissions,
        ...(ctx.event.agent.policyPlan ? { policyPlan: ctx.event.agent.policyPlan } : {}),
      }),
    };
  }

  private async runExclusive(ctx: ResidentRunContext): Promise<ResidentRunResult> {
    await this.acquireSlot();
    const activation = this.ensureActivation(ctx.sessionId);
    const runId = crypto.randomUUID();
    const start = Date.now();
    const traceContext = {
      ...(ctx.traceContext ?? { traceId: crypto.randomUUID() }),
      sessionId: ctx.sessionId,
      runId,
    };

    try {
      if (activation.idleTimer) clearTimeout(activation.idleTimer);
      activation.lifecycle = "hydrating";
      const messages = SessionBridge.buildDirectMessages(ctx.sessionId).filter(
        (
          message,
        ): message is { role: "user"; content: string } | { role: "assistant"; content: string } =>
          message.role === "user" || message.role === "assistant",
      );
      activation.lifecycle = "active";
      const agentConfig = this.buildAgentConfig(ctx, runId);
      const result = await this.runAgent(agentConfig, {
        messages,
        traceContext,
      });
      activation.lastUsedAt = Date.now();
      this.scheduleIdleRelease(ctx.sessionId, activation);
      Bus.publish(IngressEvent.Completed, {
        traceId: traceContext.traceId,
        sessionId: ctx.sessionId,
        mode: "direct",
        target: "resident",
        durationMs: Date.now() - start,
        time: Date.now(),
      });
      return {
        output: result.text,
        finishReason: result.finishReason,
        runId,
        activationId: activation.activationId,
      };
    } catch (error) {
      activation.lastUsedAt = Date.now();
      this.scheduleIdleRelease(ctx.sessionId, activation);
      Bus.publish(IngressEvent.Failed, {
        traceId: traceContext.traceId,
        sessionId: ctx.sessionId,
        mode: "direct",
        target: "resident",
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
        time: Date.now(),
      });
      throw error;
    } finally {
      this.releaseSlot();
    }
  }
}

export namespace ResidentRuntime {
  export function create(options: ResidentRuntimeOptions = {}): ResidentRuntime {
    return new ResidentRuntime(options);
  }
}

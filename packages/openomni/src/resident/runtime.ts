import { ChatAgent, type ChatAgentConfig, type ChatAgentInput } from "@openomni/agent";
import {
  Ingress,
  type Gateway,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { buildWorkerMiddleware, type TierDenyOverlay } from "../execution-runtime/middleware";
import { createAnchorCompletion } from "../execution-runtime/middleware/anchor-completion";
import { SessionBridge } from "../ingress/session-bridge";
import { EngagementContext } from "./engagement-context";

export type ResidentLifecycle = "sleeping" | "hydrating" | "active" | "idle" | "releasing";

export interface ResidentRunContext {
  readonly sessionId: string;
  readonly event: Ingress.ResolvedInboundEvent;
  readonly traceContext?: TraceContextProtocol.Type;
  readonly signal?: AbortSignal;
  /**
   * #709: the triggering delivery's wait resumption context, verbatim from
   * Gateway.Deliver. `engagementId` marks the crash-safe resume point — the
   * run hydrates that engagement's state and the executor injects the id
   * into engagement-aware tools.
   */
  readonly waitContext?: Gateway.WaitContext;
  /**
   * #709: the triggering delivery's perimeter trust verdict
   * (actorContext.trustTier, consumed verbatim per gateway-design §3) — the
   * engagement approval gate's input. Absent for wait resumptions, anonymous
   * admissions, and internal runs.
   */
  readonly actorTrustTier?: string;
  /**
   * S6: the triggering delivery's perimeter inbound treatment
   * (actorContext.inboundTreatment, consumed verbatim per gateway-design §3).
   * `evidence_only` forces this run's tool permission to deny-all — the run
   * may reason over the evidence but cannot drive tool use with authority
   * above the evidence tier. Absent for internal runs and full_access
   * deliveries (which act normally).
   */
  readonly inboundTreatment?: string;
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
  /**
   * 고도화 A — the Owner-declared tier→deny-overlay table, injected at
   * composition (server bootstrap resolves it from config), NEVER hardcoded.
   * Per delivery, the run's `actorTrustTier` indexes this table for the
   * additive deny-label cap. Keyed by `Actor.TrustTier` string; a tier with no
   * entry gets NO relaxation change (owner/co_owner/manager by default).
   * Default empty → no tier ever gains an overlay (base behavior).
   */
  readonly permissionProfiles?: Readonly<Record<string, TierDenyOverlay>>;
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

type SlotWaiter = {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

function createAbortError(): Error {
  const error = new Error("resident run aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError();
}

function abortRace(signal: AbortSignal | undefined): {
  readonly promise: Promise<never>;
  readonly cleanup: () => void;
} {
  if (!signal) {
    return {
      promise: new Promise<never>(() => undefined),
      cleanup: () => undefined,
    };
  }
  if (signal.aborted) {
    return { promise: Promise.reject(createAbortError()), cleanup: () => undefined };
  }
  let cleanup: () => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, cleanup };
}

type RuntimeAgentDef = Ingress.AgentDef & {
  readonly providerOptions?: Record<string, unknown>;
};

/**
 * #562 F2: the resident direct path runs WITHOUT a transcript fact sink ON
 * PURPOSE — not for layering reasons (this package already reaches
 * TranscriptStore, and ResidentRuntimeOptions.runAgent is injectable from
 * the server composition), but because the resident path's durable
 * assistant write is SessionBridge.storeDirectResult at the ingress handler
 * (ingress/handlers.ts handleResident): it persists the committed handler
 * output under its own message id, wrapped in the ingress audit envelope.
 * Wiring a raw-stream sink here would double-persist every resident
 * turn — the streamed message id via facts plus the committed message id
 * via projection, with diverging raw-vs-committed text. Recording facts for
 * residents therefore rides a redesign of the commit seam (record the
 * committed output as the fact), not a sink here. Resident sessions stay
 * all-projection — see the writer census in
 * packages/ledger/src/session/transcript.ts.
 */
function defaultRunAgent(config: ChatAgentConfig, input: ChatAgentInput) {
  return ChatAgent.create(config).run(input);
}

/**
 * #709 identity injection is factory-only (audit batch A): a run that carries
 * engagement identity context (a resumed engagementId or the delivery's
 * perimeter trust verdict) MUST reach the tools through the executor factory.
 * A prebuilt `toolExecutor` cannot receive per-run identity — running anyway
 * would execute engagement-aware tools with stale (or absent) identity, so
 * the composition refuses instead.
 */
export class ResidentIdentityInjectionError extends Error {
  constructor() {
    super(
      "resident run carries engagement identity context (engagementId/actorTrustTier) but the " +
        "composed agent supplies a prebuilt toolExecutor that cannot receive it; compose " +
        "toolExecutorFactory instead",
    );
    this.name = "ResidentIdentityInjectionError";
  }
}

function resolveResidentToolExecutor(
  ctx: ResidentRunContext,
  runId: string,
  workspaceRoot: string | undefined,
): ChatAgentConfig["toolExecutor"] {
  if (ctx.event.agent.toolExecutorFactory) {
    return ctx.event.agent.toolExecutorFactory({
      sessionId: ctx.sessionId,
      runId,
      agentName: extractAgentName(ctx.event),
      workspaceRoot,
      // #709: executor-owned implicit context — the tools see these as
      // injected fields the model can never forge.
      engagementId: ctx.waitContext?.engagementId,
      actorTrustTier: ctx.actorTrustTier,
    });
  }
  const carriesIdentity =
    ctx.waitContext?.engagementId !== undefined || ctx.actorTrustTier !== undefined;
  if (ctx.event.agent.toolExecutor && carriesIdentity) {
    throw new ResidentIdentityInjectionError();
  }
  return ctx.event.agent.toolExecutor;
}

function buildResidentAgentConfig(
  ctx: ResidentRunContext,
  runId: string,
  permissionProfiles: Readonly<Record<string, TierDenyOverlay>>,
): ChatAgentConfig {
  // The sandbox root / lock key comes from the COMPOSED agent config only.
  // `ctx.event.workspace` is a surface-derived identifier (an inbound event
  // field the perimeter influences) and must never become the workspace root
  // (audit batch A) — resident runs that need one get it from
  // `agent.toolConfig.workspaceRoot`, which the server composition sets.
  const workspaceRoot = ctx.event.agent.toolConfig?.workspaceRoot;
  const toolExecutor = resolveResidentToolExecutor(ctx, runId, workspaceRoot);
  const agent = ctx.event.agent as RuntimeAgentDef;

  // 고도화 A: the tier deny-overlay is looked up per delivery from the injected
  // profiles table. A run with no trust tier (internal / wait-resumption /
  // anonymous) skips the lookup entirely — the overlay stays absent, so the
  // middleware applies no cap (same guard shape as inboundTreatment).
  const tierDenyOverlay =
    ctx.actorTrustTier === undefined ? undefined : permissionProfiles[ctx.actorTrustTier];

  return {
    // The kernel is a composition layer: it chooses what observation
    // reaches, and hands the loop a port rather than a global.
    events: Bus,
    model: ctx.event.agent.model,
    systemPrompt: ctx.event.agent.systemPrompt,
    budget: ctx.event.agent.budget,
    tools: ctx.event.agent.tools,
    toolExecutor,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(agent.providerOptions ? { providerOptions: agent.providerOptions } : {}),
    middleware: buildWorkerMiddleware({
      traceId: ctx.traceContext?.traceId,
      permissions: ctx.event.agent.permissions,
      // S6 hard gate: an evidence_only delivery caps this run's tool authority
      // to deny-all, overriding whatever permissions/plan would allow.
      ...(ctx.inboundTreatment === undefined ? {} : { inboundTreatment: ctx.inboundTreatment }),
      // 고도화 A tier tool-permission cap: present only for tiers with a
      // profile entry on a delivery that carries a trust tier.
      ...(tierDenyOverlay === undefined ? {} : { tierDenyOverlay }),
      ...(ctx.event.agent.policyPlan ? { policyPlan: ctx.event.agent.policyPlan } : {}),
      compaction: {
        summarizeWith: createAnchorCompletion({
          model: ctx.event.agent.model,
          ...(agent.providerOptions === undefined
            ? {}
            : { providerOptions: agent.providerOptions }),
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
          trace: {
            traceId: ctx.traceContext?.traceId ?? "",
            sessionId: ctx.sessionId,
            runId,
          },
          events: Bus,
        }),
      },
    }),
  };
}

function extractAgentName(event: Ingress.ResolvedInboundEvent): string | undefined {
  if (event.mode === "internal") {
    return event.agentName;
  }
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
  private readonly permissionProfiles: Readonly<Record<string, TierDenyOverlay>>;

  constructor(options: ResidentRuntimeOptions = {}) {
    this.maxActive = options.maxActive ?? 10;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.slotWaitTimeoutMs = options.slotWaitTimeoutMs ?? 30_000;
    this.runAgent = options.runAgent ?? defaultRunAgent;
    // Default empty → no tier ever gains an overlay (fail-closed base posture).
    this.permissionProfiles = options.permissionProfiles ?? {};
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
    throwIfAborted(ctx.signal);
    const activation = this.ensureActivation(ctx.sessionId);
    const previous = activation.queue;
    const chained = previous
      .catch(() => undefined)
      .then(() => {
        throwIfAborted(ctx.signal);
        return this.runExclusive(ctx);
      });
    activation.queue = chained;
    const abort = abortRace(ctx.signal);
    try {
      return await Promise.race([chained, abort.promise]);
    } finally {
      abort.cleanup();
    }
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

  private async acquireSlot(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.activeRuns < this.maxActive) {
      this.activeRuns++;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (error: Error) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.reject(createAbortError());
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.reject(
          new Error(`resident activation slot wait timed out after ${this.slotWaitTimeoutMs}ms`),
        );
      }, this.slotWaitTimeoutMs);
    });
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

  private async runExclusive(ctx: ResidentRunContext): Promise<ResidentRunResult> {
    // Refused before the slot is taken: a rejection between `acquireSlot` and
    // the `try` that releases it would leak the slot for the process lifetime.
    //
    // The resident is not a trace origin — its only caller is the ingress
    // handler, which always carries the trace the inbound event started. A
    // `?? newTraceId()` here would detach the resident's run from the request
    // that asked for it.
    if (ctx.traceContext?.traceId === undefined || ctx.traceContext.traceId.length === 0) {
      throw new Error("resident run requires the inbound trace context");
    }
    await this.acquireSlot(ctx.signal);
    const runId = crypto.randomUUID();
    const start = Date.now();
    const traceContext = { ...ctx.traceContext, sessionId: ctx.sessionId, runId };

    try {
      throwIfAborted(ctx.signal);
      const activation = this.ensureActivation(ctx.sessionId);
      if (activation.idleTimer) clearTimeout(activation.idleTimer);
      activation.lifecycle = "hydrating";
      const messages = SessionBridge.buildDirectMessages(ctx.sessionId).filter(
        (message) => message.role === "user" || message.role === "assistant",
      );
      // #709 hydration (gateway-design §5): the engagement slice — active
      // delegations + the resumed engagement when this delivery carries
      // waitContext.engagementId — prepends as a machine-side context block.
      // Run-input only, never persisted to the session. The transcript
      // itself is still hydrated in FULL (no recency window exists yet) —
      // narrowing it is a recorded follow-up, not this change.
      const engagementBlock = EngagementContext.buildBlock({
        sessionId: ctx.sessionId,
        traceId: traceContext.traceId,
        resumedEngagementId: ctx.waitContext?.engagementId,
      });
      const hydrated =
        engagementBlock === undefined
          ? messages
          : [
              {
                role: "user" as const,
                content: engagementBlock,
                partMetadata: { engagementContext: true },
              },
              ...messages,
            ];
      activation.lifecycle = "active";
      const agentConfig = buildResidentAgentConfig(ctx, runId, this.permissionProfiles);
      const result = await this.runAgent(agentConfig, {
        messages: hydrated,
        traceContext,
      });
      activation.lastUsedAt = Date.now();
      this.scheduleIdleRelease(ctx.sessionId, activation);
      Bus.publish(Ingress.Events.Completed, {
        traceId: traceContext.traceId,
        sessionId: ctx.sessionId,
        mode: ctx.event.mode,
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
      const activation = this.activations.get(ctx.sessionId);
      if (!activation) throw error;
      activation.lastUsedAt = Date.now();
      this.scheduleIdleRelease(ctx.sessionId, activation);
      Bus.publish(Ingress.Events.Failed, {
        traceId: traceContext.traceId,
        sessionId: ctx.sessionId,
        mode: ctx.event.mode,
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

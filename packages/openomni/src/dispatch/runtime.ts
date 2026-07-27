import { PolicyEngine, type PolicyDecision } from "@openomni/policy";
import { Dispatch as DispatchProtocol, PolicyDecision as Decision } from "@openomni/protocol";
import { Bus, TraceContext } from "@openomni/session";
import { deriveActorContext, type DispatchRuntimeContext } from "./actor.js";
import {
  markRoutedPendingInteraction,
  requestedPendingInteractionAction,
  routePendingInteraction,
} from "./pending-interaction-routing.js";
import type { DurableWaitV1, WaitKernelService } from "../ingress/wait-correlation.js";
import type { AuthorityProjectionQueryPort } from "../ingress/actor-resolver.js";
import { createDefaultDispatchPolicy, type DispatchPolicyContext } from "./policy.js";
import { registerDispatchPolicy, type DispatchPolicyRegistration } from "./policy-registration.js";
import { DispatchRegistry, type DispatchHandler, type DispatchHandlerContext } from "./registry.js";
import {
  eventBase,
  normalizeHandlerOutput,
  policyTraceContext,
  resourceDescriptor,
} from "./runtime-support.js";

export interface DispatchSubmitOptions extends DispatchRuntimeContext, DispatchHandlerContext {
  readonly policies?: readonly DispatchPolicyRegistration[];
  readonly includeDefaultPolicies?: boolean;
  readonly onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;
  readonly sourceTool?: string;
}

export interface DispatchRuntimeOptions {
  readonly waitKernel: WaitKernelService;
  readonly authorityQueries: AuthorityProjectionQueryPort;
  readonly registry?: DispatchRegistry;
  readonly policies?: readonly DispatchPolicyRegistration[];
  readonly includeDefaultPolicies?: boolean;
  readonly onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;
}

function collectPolicies(
  authorityQueries: AuthorityProjectionQueryPort,
  runtimePolicies: readonly DispatchPolicyRegistration[],
  submitPolicies: readonly DispatchPolicyRegistration[] | undefined,
  includeDefaultPolicies: boolean,
): DispatchPolicyRegistration[] {
  return [
    ...(includeDefaultPolicies ? [createDefaultDispatchPolicy(authorityQueries)] : []),
    ...runtimePolicies,
    ...(submitPolicies ?? []),
  ];
}

function denyStalePinnedInteraction(
  command: DispatchProtocol.Command,
  start: number,
  reason: string,
): DispatchProtocol.Result {
  Bus.publish(DispatchProtocol.Events.Denied, {
    ...eventBase(command),
    verdict: "deny",
    reason,
    policyId: "dispatch.pending-interaction-revalidation",
    effects: [],
  });
  return DispatchProtocol.Result.parse({
    dispatchId: command.dispatchId,
    status: "denied",
    reason,
    error: reason,
    durationMs: Date.now() - start,
  });
}

const submitPinnedInteraction = Symbol("submitPinnedInteraction");

export function submitPinnedPendingInteraction(
  runtime: DispatchRuntime,
  input: DispatchProtocol.Input,
  wait: DurableWaitV1,
  options: DispatchSubmitOptions = {},
): Promise<DispatchProtocol.Result> {
  return runtime[submitPinnedInteraction](input, wait, options);
}

export class DispatchRuntime {
  readonly registry: DispatchRegistry;
  private readonly policies: readonly DispatchPolicyRegistration[];
  private readonly includeDefaultPolicies: boolean;
  private readonly onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;
  private readonly waitKernel: WaitKernelService;
  private readonly authorityQueries: AuthorityProjectionQueryPort;

  constructor(options: DispatchRuntimeOptions) {
    this.registry = options.registry ?? new DispatchRegistry();
    this.waitKernel = options.waitKernel;
    this.authorityQueries = options.authorityQueries;
    this.policies = options.policies ?? [];
    this.includeDefaultPolicies = options.includeDefaultPolicies ?? true;
    this.onPolicyDecision = options.onPolicyDecision;
  }

  register(action: string, handler: DispatchHandler): () => void {
    return this.registry.register(action, handler);
  }

  async submit(
    input: DispatchProtocol.Input,
    options: DispatchSubmitOptions = {},
  ): Promise<DispatchProtocol.Result> {
    return this.submitResolved(input, options);
  }

  async [submitPinnedInteraction](
    input: DispatchProtocol.Input,
    wait: DurableWaitV1,
    options: DispatchSubmitOptions,
  ): Promise<DispatchProtocol.Result> {
    return this.submitResolved(input, options, wait);
  }

  private async submitResolved(
    input: DispatchProtocol.Input,
    options: DispatchSubmitOptions,
    pinnedWait?: DurableWaitV1,
  ): Promise<DispatchProtocol.Result> {
    const parsed = DispatchProtocol.Input.parse(input);
    const trace = options.traceId ? { traceId: options.traceId } : TraceContext.create();
    const actor = deriveActorContext(options);
    const requestedPendingAction = requestedPendingInteractionAction(parsed.payload);
    const initialPinnedValidation = pinnedWait
      ? await this.waitKernel.revalidatePinned({
          pinned: pinnedWait,
          requestedAction: requestedPendingAction,
        })
      : undefined;
    const activePinnedWait =
      initialPinnedValidation?.kind === "valid" ? initialPinnedValidation.wait : undefined;
    const command = await routePendingInteraction(
      this.waitKernel,
      DispatchProtocol.Command.parse({
        ...parsed,
        dispatchId: crypto.randomUUID(),
        actor,
        traceId: trace.traceId,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        submittedAt: Date.now(),
      }),
      activePinnedWait,
    );
    const start = Date.now();

    Bus.publish(DispatchProtocol.Events.Submitted, {
      ...eventBase(command),
      ...(command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}),
    });

    const engine = PolicyEngine.create<DispatchPolicyContext>({
      traceContext: policyTraceContext(command, trace.traceId),
      onDecision: options.onPolicyDecision ?? this.onPolicyDecision,
      auditEmit: Bus.publish,
    });
    for (const reg of collectPolicies(
      this.authorityQueries,
      this.policies,
      options.policies,
      options.includeDefaultPolicies ?? this.includeDefaultPolicies,
    )) {
      registerDispatchPolicy(engine, reg);
    }

    const decision = await engine.dispatchPoint("dispatch.action.pre", {
      actor: command.actor,
      dispatchId: command.dispatchId,
      action: command.action,
      target: command.target,
      ...(command.correlation !== undefined && { correlation: command.correlation }),
      ...(command.sessionId !== undefined && { sessionId: command.sessionId }),
      ...(command.runId !== undefined && { runId: command.runId }),
      labels: [
        { value: `dispatch.${command.action}`, source: "system" },
        { value: `actor.${command.actor.kind}`, source: "system" },
        { value: `target.${command.target.kind}`, source: "system" },
      ],
      resourceDescriptor: resourceDescriptor(command.action),
      traceContext: policyTraceContext(command, trace.traceId),
    });

    if (Decision.isBlocking(decision)) {
      const reason = Decision.reason(decision, "dispatch.authorize denied");
      Bus.publish(DispatchProtocol.Events.Denied, {
        ...eventBase(command),
        verdict: decision.verdict === "pending" ? "pending" : "deny",
        reason,
        policyId: decision.policyId,
        effects: decision.effects,
      });
      return DispatchProtocol.Result.parse({
        dispatchId: command.dispatchId,
        status: "denied",
        reason,
        error: reason,
        durationMs: Date.now() - start,
      });
    }

    if (pinnedWait) {
      const validation = await this.waitKernel.revalidatePinned({
        pinned: pinnedWait,
        requestedAction: requestedPendingAction,
      });
      if (validation.kind === "invalid") {
        return denyStalePinnedInteraction(command, start, validation.reason);
      }
    }

    Bus.publish(DispatchProtocol.Events.Authorized, {
      ...eventBase(command),
      verdict: "allow",
      reason: Decision.reason(decision, "dispatch.authorize allowed"),
      policyId: decision.policyId,
      effects: decision.effects,
    });

    const handler = this.registry.get(command.action);
    if (!handler) {
      const reason = `No dispatch handler registered for ${command.action}`;
      Bus.publish(DispatchProtocol.Events.Failed, {
        ...eventBase(command),
        durationMs: Date.now() - start,
        reason,
      });
      return DispatchProtocol.Result.parse({
        dispatchId: command.dispatchId,
        status: "failed",
        error: reason,
        durationMs: Date.now() - start,
      });
    }

    const routingStartedAt = Date.now();
    await markRoutedPendingInteraction(this.waitKernel, command);
    Bus.publish(DispatchProtocol.Events.Routed, { ...eventBase(command), handler: command.action });

    if (pinnedWait) {
      const validation = await this.waitKernel.revalidatePinned({
        pinned: pinnedWait,
        requestedAction: requestedPendingAction,
        resolvedSinceDbMs: routingStartedAt,
      });
      if (validation.kind === "invalid") {
        return denyStalePinnedInteraction(command, start, validation.reason);
      }
    }

    try {
      const raw = await handler(command, {
        signal: options.signal,
        ...((options.wait ?? command.wait) !== undefined
          ? { wait: options.wait ?? command.wait }
          : {}),
        ...((options.timeoutMs ?? command.timeoutMs) !== undefined
          ? { timeoutMs: options.timeoutMs ?? command.timeoutMs }
          : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.agentName ? { agentName: options.agentName } : {}),
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        ...(options.sourceTool ? { sourceTool: options.sourceTool } : {}),
      });
      const output = normalizeHandlerOutput(raw);
      Bus.publish(DispatchProtocol.Events.Completed, {
        ...eventBase(command),
        handler: command.action,
        durationMs: Date.now() - start,
      });
      return DispatchProtocol.Result.parse({
        dispatchId: command.dispatchId,
        status: "completed",
        output,
        handler: command.action,
        durationMs: Date.now() - start,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      Bus.publish(DispatchProtocol.Events.Failed, {
        ...eventBase(command),
        handler: command.action,
        durationMs: Date.now() - start,
        reason,
      });
      return DispatchProtocol.Result.parse({
        dispatchId: command.dispatchId,
        status: "failed",
        error: reason,
        handler: command.action,
        durationMs: Date.now() - start,
      });
    }
  }
}

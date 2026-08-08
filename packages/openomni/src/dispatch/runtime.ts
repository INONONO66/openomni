import { PolicyEngine, type PolicyDecision } from "@openomni/policy";
import { Dispatch as DispatchProtocol, PolicyDecision as Decision } from "@openomni/protocol";
import { Bus, PendingInteractionStore, TraceContext } from "@openomni/session";
import { deriveActorContext, type DispatchRuntimeContext } from "./actor.js";
import {
  markRoutedPendingInteraction,
  requestedPendingInteractionAction,
  routePendingInteraction,
} from "./pending-interaction-routing.js";
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
  readonly registry?: DispatchRegistry;
  readonly policies?: readonly DispatchPolicyRegistration[];
  readonly includeDefaultPolicies?: boolean;
  readonly onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;
}

function collectPolicies(
  runtimePolicies: readonly DispatchPolicyRegistration[],
  submitPolicies: readonly DispatchPolicyRegistration[] | undefined,
  includeDefaultPolicies: boolean,
): DispatchPolicyRegistration[] {
  return [
    ...(includeDefaultPolicies ? [createDefaultDispatchPolicy()] : []),
    ...runtimePolicies,
    ...(submitPolicies ?? []),
  ];
}

type PinnedInteractionValidation =
  | { readonly record: PendingInteractionStore.Record }
  | { readonly reason: string };

function revalidatePinnedInteraction(
  pinned: PendingInteractionStore.Record,
  requestedAction: PendingInteractionStore.Record["allowedActions"][number],
  now = Date.now(),
): PinnedInteractionValidation {
  const current = PendingInteractionStore.get(pinned.id);
  if (!current) return { reason: "dispatch.pending_interaction.not_found" };

  const active =
    (current.status === "open" && now <= current.expiresAt) ||
    ((current.status === "resolved" || current.status === "follow_up") &&
      current.resolvedAt !== undefined &&
      now <= current.resolvedAt + current.followUpWindow);
  if (!active) return { reason: "dispatch.pending_interaction.inactive" };

  if (
    current.createdAt !== pinned.createdAt ||
    current.endpointId !== pinned.endpointId ||
    current.channelId !== pinned.channelId ||
    current.targetActorId !== pinned.targetActorId ||
    current.correlation.replyToMessageId !== pinned.correlation.replyToMessageId ||
    current.correlation.threadId !== pinned.correlation.threadId ||
    current.correlation.tokenHash !== pinned.correlation.tokenHash ||
    current.correlation.externalConversationId !== pinned.correlation.externalConversationId
  ) {
    return { reason: "dispatch.pending_interaction.identity_mismatch" };
  }
  if (current.sessionId !== pinned.sessionId) {
    return { reason: "dispatch.pending_interaction.session_mismatch" };
  }
  if (current.workerRunId !== pinned.workerRunId) {
    return { reason: "dispatch.pending_interaction.run_mismatch" };
  }
  if (!current.allowedActions.includes(requestedAction)) {
    return { reason: "dispatch.pending_interaction.action.denied" };
  }
  return { record: current };
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
  pendingInteraction: PendingInteractionStore.Record,
  options: DispatchSubmitOptions = {},
): Promise<DispatchProtocol.Result> {
  return runtime[submitPinnedInteraction](input, pendingInteraction, options);
}

export class DispatchRuntime {
  readonly registry: DispatchRegistry;
  private readonly policies: readonly DispatchPolicyRegistration[];
  private readonly includeDefaultPolicies: boolean;
  private readonly onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;

  constructor(options: DispatchRuntimeOptions = {}) {
    this.registry = options.registry ?? new DispatchRegistry();
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
    pendingInteraction: PendingInteractionStore.Record,
    options: DispatchSubmitOptions,
  ): Promise<DispatchProtocol.Result> {
    return this.submitResolved(input, options, pendingInteraction);
  }

  private async submitResolved(
    input: DispatchProtocol.Input,
    options: DispatchSubmitOptions,
    pendingInteraction?: PendingInteractionStore.Record,
  ): Promise<DispatchProtocol.Result> {
    const parsed = DispatchProtocol.Input.parse(input);
    const trace = options.traceId ? { traceId: options.traceId } : TraceContext.create();
    const actor = deriveActorContext(options);
    const requestedPendingAction = requestedPendingInteractionAction(parsed.payload);
    const initialPinnedValidation = pendingInteraction
      ? revalidatePinnedInteraction(pendingInteraction, requestedPendingAction)
      : undefined;
    const activePinnedInteraction =
      initialPinnedValidation && "record" in initialPinnedValidation
        ? initialPinnedValidation.record
        : undefined;
    const command = routePendingInteraction(
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
      activePinnedInteraction,
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

    if (pendingInteraction) {
      const validation = revalidatePinnedInteraction(pendingInteraction, requestedPendingAction);
      if ("reason" in validation) {
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

    // No await sits between the post-policy revalidation above and this point;
    // markRoutedPendingInteraction is our own deterministic transition, so a
    // third re-validation here would only re-check our own mutation.
    markRoutedPendingInteraction(command);
    Bus.publish(DispatchProtocol.Events.Routed, { ...eventBase(command), handler: command.action });

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

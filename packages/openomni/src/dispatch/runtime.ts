import { PolicyEngine, type PolicyDecision, type PolicyRegistration } from "@openomni/agent";
import {
  Dispatch as DispatchProtocol,
  PolicyDecision as Decision,
  type RuntimeResource,
} from "@openomni/protocol";
import { Bus, TraceContext } from "@openomni/session";
import { deriveActorContext, type DispatchRuntimeContext } from "./actor.js";
import { createDefaultDispatchPolicy } from "./policy.js";
import { DispatchRegistry, type DispatchHandler, type DispatchHandlerContext } from "./registry.js";

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

type DispatchEventPayload = {
  readonly dispatchId: string;
  readonly traceId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly actor: DispatchProtocol.ActorContext;
  readonly action: string;
  readonly target: DispatchProtocol.Target;
  readonly correlation?: string;
  readonly time: number;
};

export interface DispatchSubmitOptions extends DispatchRuntimeContext, DispatchHandlerContext {
  readonly policies?: readonly PolicyRegistration[];
  readonly includeDefaultPolicies?: boolean;
  readonly onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;
  readonly sourceTool?: string;
}

export interface DispatchRuntimeOptions {
  readonly registry?: DispatchRegistry;
  readonly policies?: readonly PolicyRegistration[];
  readonly includeDefaultPolicies?: boolean;
  readonly onPolicyDecision?: (decision: PolicyDecision) => void | Promise<void>;
}

function eventBase(command: DispatchProtocol.Command): DispatchEventPayload {
  return {
    dispatchId: command.dispatchId,
    ...(command.traceId ? { traceId: command.traceId } : {}),
    ...(command.sessionId ? { sessionId: command.sessionId } : {}),
    ...(command.runId ? { runId: command.runId } : {}),
    actor: command.actor,
    action: command.action,
    target: command.target,
    ...(command.correlation ? { correlation: command.correlation } : {}),
    time: Date.now(),
  };
}

function resourceDescriptor(action: string): RuntimeResource.Descriptor {
  return {
    id: `dispatch:${action}`,
    kind: "dispatch",
    labels: ["dispatch", `dispatch.action.${action}`],
    capabilities: ["route"],
    effects: ["cross-session"],
    source: { type: "runtime" },
  };
}

function policyTraceContext(command: DispatchProtocol.Command, fallbackTraceId: string) {
  return {
    traceId: command.traceId ?? fallbackTraceId,
    ...(command.sessionId ? { sessionId: command.sessionId } : {}),
    ...(command.runId ? { runId: command.runId } : {}),
  };
}

function collectPolicies(
  runtimePolicies: readonly PolicyRegistration[],
  submitPolicies: readonly PolicyRegistration[] | undefined,
  includeDefaultPolicies: boolean,
): PolicyRegistration[] {
  return [
    ...(includeDefaultPolicies ? [createDefaultDispatchPolicy()] : []),
    ...runtimePolicies,
    ...(submitPolicies ?? []),
  ];
}

function normalizeHandlerOutput(value: Awaited<ReturnType<DispatchHandler>>): unknown {
  if (value && typeof value === "object" && "output" in value) {
    return (value as { output?: unknown }).output;
  }
  return value;
}

export class DispatchRuntime {
  readonly registry: DispatchRegistry;
  private readonly policies: readonly PolicyRegistration[];
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
    const parsed = DispatchProtocol.Input.parse(input);
    const trace = options.traceId ? { traceId: options.traceId } : TraceContext.create();
    const actor = deriveActorContext(options);
    const command = DispatchProtocol.Command.parse({
      ...parsed,
      dispatchId: crypto.randomUUID(),
      actor,
      traceId: trace.traceId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
      submittedAt: Date.now(),
    });
    const start = Date.now();

    Bus.publish(DispatchProtocol.Events.Submitted, {
      ...eventBase(command),
      ...(command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}),
    });

    const engine = PolicyEngine.create({
      traceContext: policyTraceContext(command, trace.traceId),
      onDecision: options.onPolicyDecision ?? this.onPolicyDecision,
    });
    for (const reg of collectPolicies(
      this.policies,
      options.policies,
      options.includeDefaultPolicies ?? this.includeDefaultPolicies,
    )) {
      engine.register(reg);
    }

    const decision = await engine.dispatch("dispatch.authorize", {
      steps: [],
      usage: emptyUsage,
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      labels: [
        { value: `dispatch.${command.action}`, source: "system" },
        { value: `actor.${command.actor.kind}`, source: "system" },
        { value: `target.${command.target.kind}`, source: "system" },
      ],
      toolName: "dispatch",
      toolInput: {
        actor: command.actor,
        dispatchId: command.dispatchId,
        action: command.action,
        target: command.target,
        sessionId: command.sessionId,
        runId: command.runId,
      },
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

export const Dispatch = {
  Runtime: DispatchRuntime,
  Registry: DispatchRegistry,
} as const;

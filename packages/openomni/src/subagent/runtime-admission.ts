import { PolicyEngine } from "@openomni/policy";
import {
  createToolPermissionPolicy,
  type PolicyContext,
  type PolicyRegistration,
} from "@openomni/agent";
import { Policy, PolicyDecision, type RuntimeResource } from "@openomni/protocol";
import { Bus, WorkerGrantStore } from "@openomni/session";
import {
  buildAgentLifecycleMiddleware,
  registrationsAbsentFrom,
} from "../execution-runtime/middleware.js";
import { SubagentSpawnPolicyMiddleware } from "./middleware/subagent-spawn-policy.js";
import type { RuntimeConfig } from "./transcript";

const emptyDelegationUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

type ResourcePolicyContext = Omit<PolicyContext, "timing"> & {
  readonly resourceDescriptor: RuntimeResource.Descriptor;
};

export type PreDelegationOperation = "spawn" | "spawn_background" | "send";

interface ChildRuntimeAdmissionSummary {
  readonly toolNames?: readonly string[];
  readonly permissions?: Policy.Permission;
  readonly childRuntimeMiddlewareNames?: readonly string[];
  readonly hasExplicitRuntimePolicy: boolean;
}

type RuntimePolicyConfig = RuntimeConfig & { permissions?: Policy.Permission };
type DelegationConstraintConfig = {
  permissions?: Policy.Permission;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
};

export function hasExplicitRuntimePolicy(config: RuntimePolicyConfig): boolean {
  return config.permissions !== undefined || config.childMiddleware !== undefined;
}

export function summarizeChildRuntimeAdmission(
  config: RuntimePolicyConfig,
): ChildRuntimeAdmissionSummary | undefined {
  const toolNames = config.tools?.map((tool) => tool.name);
  const permissions = config.admissionPermissions ?? config.permissions;
  const childRuntimeMiddlewareNames = config.childMiddleware?.map(
    (registration) => registration.name,
  );
  if (
    toolNames === undefined &&
    permissions === undefined &&
    childRuntimeMiddlewareNames === undefined
  ) {
    return undefined;
  }

  return {
    ...(toolNames !== undefined && { toolNames }),
    ...(permissions !== undefined && { permissions }),
    ...(childRuntimeMiddlewareNames !== undefined && { childRuntimeMiddlewareNames }),
    hasExplicitRuntimePolicy: hasExplicitRuntimePolicy(config),
  };
}

export async function dispatchPreDelegation(input: {
  readonly middleware?: readonly PolicyRegistration[];
  readonly childAgent: string;
  readonly parentSessionId?: string;
  readonly workerRunId?: string;
  readonly operation: PreDelegationOperation;
  readonly prompt: string;
  readonly childRuntime?: ChildRuntimeAdmissionSummary;
}): Promise<Policy.PolicyDecision> {
  if (!input.middleware?.length) {
    // Authority invariant: a Worker spawn crosses a session boundary, so missing
    // admission middleware fails closed; the Resident (no parent) has top-level authority.
    if (input.parentSessionId === undefined) {
      return PolicyDecision.allow({
        policyId: "subagent.delegation",
        reasonCodes: ["resident-spawn-allowed"],
      });
    }
    return PolicyDecision.deny({
      policyId: "subagent.delegation",
      reasonCodes: ["no-middleware-registered"],
      effects: [{ type: "run.abort", reason: "worker spawn requires delegation middleware" }],
    });
  }

  // Authority invariant: worker actors crossing a session boundary must hold a WorkerGrant.
  // Mirrors dispatch/policy.ts evaluateWorkerGrant() on the cross-boundary dispatch path.
  if (input.parentSessionId !== undefined && input.workerRunId !== undefined) {
    const action = input.operation === "send" ? "worker.send" : "worker.spawn";
    const grantResult = WorkerGrantStore.evaluate({
      workerRunId: input.workerRunId,
      action,
      sessionId: input.parentSessionId,
    });
    if (!grantResult.allowed) {
      return PolicyDecision.deny({
        policyId: "subagent.delegation",
        reasonCodes: [grantResult.reason, "worker-grant.denied"],
        effects: [{ type: "run.abort", reason: grantResult.reason }],
      });
    }
  }

  const traceContext = createDelegationTrace(input.parentSessionId);
  const engine = PolicyEngine.create({
    traceContext,
    audit:
      traceContext === undefined
        ? false
        : {
            sessionId: traceContext.sessionId,
            action: `delegation.${input.operation}`,
            resource: `agent.${input.childAgent}`,
          },
    auditEmit: Bus.publish,
  });
  for (const reg of input.middleware) {
    engine.register(reg);
  }

  const resourceDescriptor = createSubagentDescriptor(input.childAgent, input.operation);
  const policyContext: ResourcePolicyContext = {
    steps: [],
    usage: emptyDelegationUsage,
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    toolName: "subagent",
    toolLabels: resourceDescriptor.labels,
    toolInput: {
      operation: input.operation,
      childAgent: input.childAgent,
      prompt: input.prompt,
      ...(input.parentSessionId !== undefined && { parentSessionId: input.parentSessionId }),
      ...childRuntimeAdmissionFields(input.childRuntime),
    },
    labels: [
      { value: `actor.child:${input.childAgent}`, source: "system" },
      ...(input.parentSessionId !== undefined
        ? [{ value: `actor.parent:${input.parentSessionId}`, source: "system" as const }]
        : []),
    ],
    resourceDescriptor,
    traceContext,
  };

  return engine.dispatch("invoke.prepare", policyContext);
}

export function applyPreDelegationDecision(
  config: DelegationConstraintConfig,
  decision: Policy.PolicyDecision,
  fallbackReason: string,
): void {
  if (PolicyDecision.isBlocking(decision)) {
    throw new Error(PolicyDecision.reason(decision, fallbackReason));
  }
  applyDelegationConstraints(config, decision);
}

export function buildChildRunMiddleware(
  config: RuntimePolicyConfig,
  hasExplicitChildRuntimePolicy = hasExplicitRuntimePolicy(config),
): PolicyRegistration[] {
  const childRuntimeMiddleware = SubagentSpawnPolicyMiddleware.buildChildRuntimeMiddleware({
    middleware: config.childMiddleware,
    hasExplicitRuntimePolicy: hasExplicitChildRuntimePolicy,
  });
  return [
    ...registrationsAbsentFrom(buildAgentLifecycleMiddleware(undefined), childRuntimeMiddleware),
    ...(config.permissions ? [createToolPermissionPolicy({ permission: config.permissions })] : []),
    ...childRuntimeMiddleware,
  ];
}

function childRuntimeAdmissionFields(
  summary: ChildRuntimeAdmissionSummary | undefined,
): Record<string, unknown> {
  if (summary === undefined) return {};
  return {
    childRuntime: summary,
    ...(summary.toolNames !== undefined && { childToolNames: summary.toolNames.join(",") }),
    ...(summary.childRuntimeMiddlewareNames !== undefined && {
      childRuntimeMiddlewareNames: summary.childRuntimeMiddlewareNames.join(","),
    }),
    childHasExplicitRuntimePolicy: String(summary.hasExplicitRuntimePolicy),
  };
}

function createDelegationTrace(parentSessionId: string | undefined) {
  if (parentSessionId === undefined) return undefined;
  return { traceId: crypto.randomUUID(), sessionId: parentSessionId };
}

function createSubagentDescriptor(
  childAgent: string,
  operation: PreDelegationOperation,
): RuntimeResource.Descriptor {
  if (operation === "send") {
    return {
      id: "worker:agent:subagent_send",
      kind: "worker",
      source: { type: "agent", agentId: childAgent },
      labels: ["source.agent", "delegation.subagent"],
      capabilities: ["delegation.send"],
      effects: ["session.message"],
    };
  }

  if (operation === "spawn_background") {
    return {
      id: "worker:agent:background_launch",
      kind: "worker",
      source: { type: "agent", agentId: childAgent },
      labels: ["source.agent", "delegation.background"],
      capabilities: ["delegation.background"],
      effects: ["session.create"],
    };
  }

  return {
    id: "worker:agent:subagent_spawn",
    kind: "worker",
    source: { type: "agent", agentId: childAgent },
    labels: ["source.agent", "delegation.subagent"],
    capabilities: ["delegation.spawn"],
    effects: ["session.create"],
  };
}

function applyDelegationConstraints(
  config: DelegationConstraintConfig,
  decision: Policy.PolicyDecision,
): void {
  const constraints = decision.effects
    .filter(
      (effect): effect is Extract<Policy.PolicyEffect, { type: "delegation.set_constraints" }> =>
        effect.type === "delegation.set_constraints",
    )
    .at(-1)?.constraints;

  if (!constraints) return;
  const permissions = constraints.permissions;
  if (permissions !== undefined) {
    const parsed = Policy.Permission.safeParse(permissions);
    if (!parsed.success) {
      throw new Error("invoke.prepare policy returned invalid delegation constraints");
    }
    config.permissions = parsed.data;
  }
  if (typeof constraints.softTimeoutMs === "number")
    config.softTimeoutMs = constraints.softTimeoutMs;
  if (typeof constraints.hardTimeoutMs === "number")
    config.hardTimeoutMs = constraints.hardTimeoutMs;
}

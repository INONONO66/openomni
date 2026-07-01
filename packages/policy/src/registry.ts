import { Operational, type Policy } from "@openomni/protocol";
import type { AuditEmit, GenericPolicyContext, PolicyRegistrationGeneric } from "./engine/types";

export interface RuntimeContext {
  readonly workspaceRoot?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly agentName?: string;
  readonly auditEmit?: AuditEmit;
}

export type PolicyFactory = (
  config: unknown,
  runtime: RuntimeContext,
) => PolicyRegistrationGeneric<GenericPolicyContext>;

export interface PolicyRegistryInstance {
  register(id: string, factory: PolicyFactory): void;
  resolve(
    plan: Policy.PolicyPlan,
    runtime: RuntimeContext,
  ): PolicyRegistrationGeneric<GenericPolicyContext>[];
  has(id: string): boolean;
  list(): string[];
}

function publishOptionalPolicyMissing(id: string, runtime: RuntimeContext): void {
  runtime.auditEmit?.(Operational.Warn, {
    traceId: runtime.runId ?? crypto.randomUUID(),
    ...(runtime.sessionId !== undefined && { sessionId: runtime.sessionId }),
    time: Date.now(),
    component: "agent.policy.registry",
    msg: "optional policy missing",
    context: {
      policyId: id,
      ...(runtime.workspaceRoot !== undefined && { workspaceRoot: runtime.workspaceRoot }),
      ...(runtime.agentName !== undefined && { agentName: runtime.agentName }),
    },
  });
}

function create(): PolicyRegistryInstance {
  const factories = new Map<string, PolicyFactory>();

  return {
    register(id, factory) {
      factories.set(id, factory);
    },

    resolve(plan, runtime) {
      const registrations: PolicyRegistrationGeneric<GenericPolicyContext>[] = [];

      for (const policy of plan.policies) {
        const factory = factories.get(policy.id);
        if (!factory) {
          if (policy.required) {
            throw new Error(`Required policy '${policy.id}' is not registered`);
          }
          publishOptionalPolicyMissing(policy.id, runtime);
          continue;
        }

        registrations.push(factory(policy.config, runtime));
      }

      return registrations;
    },

    has(id) {
      return factories.has(id);
    },

    list() {
      return Array.from(factories.keys());
    },
  };
}

export const PolicyRegistry = { create };

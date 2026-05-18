import { Operational, type Policy } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import {
  createBudgetReassurancePolicy,
  createBudgetWarningPolicy,
  createCompactionPolicy,
  createIdleNudgePolicy,
  createToolPermissionPolicy,
} from "./builtin";
import type { PolicyRegistration } from "./types";

export interface RuntimeContext {
  readonly workspaceRoot?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly agentName?: string;
}

export type PolicyFactory = (config: unknown, runtime: RuntimeContext) => PolicyRegistration;

export interface PolicyRegistryInstance {
  register(id: string, factory: PolicyFactory): void;
  resolve(plan: Policy.PolicyPlan, runtime: RuntimeContext): PolicyRegistration[];
  has(id: string): boolean;
  list(): string[];
}

function publishOptionalPolicyMissing(id: string, runtime: RuntimeContext): void {
  Bus.publish(Operational.Warn, {
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
      const registrations: PolicyRegistration[] = [];

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

function defaultRegistry(): PolicyRegistryInstance {
  const registry = create();

  registry.register("builtin:budget-reassurance", () => createBudgetReassurancePolicy());
  registry.register("builtin:budget-warning", () => createBudgetWarningPolicy());
  registry.register("builtin:compaction", (config) =>
    createCompactionPolicy(config as Parameters<typeof createCompactionPolicy>[0]),
  );
  registry.register("builtin:idle-nudge", (config) =>
    createIdleNudgePolicy(config as Parameters<typeof createIdleNudgePolicy>[0]),
  );
  registry.register("builtin:tool-permission", (config) =>
    createToolPermissionPolicy(config as Parameters<typeof createToolPermissionPolicy>[0]),
  );

  return registry;
}

export const PolicyRegistry = { create };
export { defaultRegistry };

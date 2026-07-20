import { Operational, type Policy } from "@openomni/protocol";
import type {
  AuditEmit,
  GenericPolicyContext,
  PolicyEngineRegistrationGeneric,
} from "./engine/types";

export interface RuntimeContext {
  readonly workspaceRoot?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly agentName?: string;
  readonly auditEmit?: AuditEmit;
}

export type PolicyFactory<TCtx extends GenericPolicyContext = GenericPolicyContext> = (
  config: unknown,
  runtime: RuntimeContext,
) => PolicyEngineRegistrationGeneric<TCtx>;

export interface PolicyRegistryInstance<TCtx extends GenericPolicyContext = GenericPolicyContext> {
  register(id: string, factory: PolicyFactory<TCtx>): void;
  resolve(
    plan: Policy.PolicyPlan,
    runtime: RuntimeContext,
  ): PolicyEngineRegistrationGeneric<TCtx>[];
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

function create<
  TCtx extends GenericPolicyContext = GenericPolicyContext,
>(): PolicyRegistryInstance<TCtx> {
  const factories = new Map<string, PolicyFactory<TCtx>>();

  return {
    register(id, factory) {
      factories.set(id, factory);
    },

    resolve(plan, runtime) {
      const registrations: PolicyEngineRegistrationGeneric<TCtx>[] = [];

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

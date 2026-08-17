import { Operational, type Policy } from "@openomni/protocol";
import type {
  AuditEmit,
  CanonicalPolicyRegistrationGeneric,
  GenericPolicyContext,
} from "./engine/types";

interface RuntimeContext {
  readonly workspaceRoot?: string;
  readonly traceId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly agentName?: string;
  readonly auditEmit?: AuditEmit;
}

type PolicyFactory<TCtx extends GenericPolicyContext = GenericPolicyContext> = (
  config: unknown,
  runtime: RuntimeContext,
) => CanonicalPolicyRegistrationGeneric<TCtx>;

export interface PolicyRegistryInstance<TCtx extends GenericPolicyContext = GenericPolicyContext> {
  register(id: string, factory: PolicyFactory<TCtx>): void;
  resolve(
    plan: Policy.PolicyPlan,
    runtime: RuntimeContext,
  ): CanonicalPolicyRegistrationGeneric<TCtx>[];
}

function publishOptionalPolicyMissing(id: string, runtime: RuntimeContext): void {
  // No trace, no record. The previous `runtime.runId ?? crypto.randomUUID()`
  // put a value of the wrong kind in a field every reader treats as a trace,
  // and a minted one correlates to nothing — both are worse than silence.
  if (runtime.traceId === undefined || runtime.traceId.length === 0) return;
  runtime.auditEmit?.(Operational.Warn, {
    traceId: runtime.traceId,
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
      const registrations: CanonicalPolicyRegistrationGeneric<TCtx>[] = [];

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
  };
}

export const PolicyRegistry = { create };

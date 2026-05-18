import {
  createIdleNudgePolicy,
  createToolPermissionPolicy,
  defaultRegistry,
} from "@openomni/agent";
import type { PolicyRegistration } from "@openomni/agent";
import { Policy } from "@openomni/protocol";

export interface WorkerMiddlewareConfig {
  permissions?: Policy.Permission;
  policyPlan?: Policy.PolicyPlan;
}

const FAIL_CLOSED_TOOL_PERMISSION: Policy.Permission = { action: "tool.call", denylist: ["*"] };

export function buildWorkerMiddleware(config: WorkerMiddlewareConfig): PolicyRegistration[] {
  if (config.policyPlan) {
    return resolvePoliciesFromPlan(hydrateLegacyPermissions(config.policyPlan, config.permissions));
  }

  return buildLegacyMiddleware(config.permissions);
}

function buildLegacyMiddleware(permissions?: Policy.Permission): PolicyRegistration[] {
  return [
    createToolPermissionPolicy({
      permission: permissions ?? { action: "tool.call" },
    }),
    createIdleNudgePolicy(),
  ];
}

function resolvePoliciesFromPlan(plan: Policy.PolicyPlan): PolicyRegistration[] {
  const registry = defaultRegistry();
  return registry.resolve(plan, {});
}

function hydrateLegacyPermissions(
  plan: Policy.PolicyPlan,
  permissions: Policy.Permission | undefined,
): Policy.PolicyPlan {
  const fallbackPermission = permissions ?? { action: "tool.call" };
  let changed = false;
  const policies = plan.policies.map((policy) => {
    if (policy.id !== "builtin:tool-permission") return policy;
    const config = policy.config ?? {};
    // Keep legacy permissions effective for policy plans that select the
    // builtin guard without owning its config yet.
    // A present-but-invalid permission is treated as explicit and fails closed.
    if (!("permission" in config)) {
      changed = true;
      return {
        ...policy,
        config: {
          ...config,
          permission: fallbackPermission,
        },
      };
    }

    if (Policy.Permission.safeParse(config.permission).success) return policy;

    changed = true;
    return {
      ...policy,
      config: {
        ...config,
        permission: FAIL_CLOSED_TOOL_PERMISSION,
      },
    };
  });

  return changed ? { ...plan, policies } : plan;
}

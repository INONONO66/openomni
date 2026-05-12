import {
  createIdleNudgePolicy,
  createToolPermissionPolicy,
  defaultRegistry,
} from "@openomni/agent";
import type { PolicyRegistration } from "@openomni/agent";
import type { Policy } from "@openomni/protocol";

export interface WorkerMiddlewareConfig {
  permissions?: Policy.Permission;
  policyPlan?: Policy.PolicyPlan;
}

export function buildWorkerMiddleware(config: WorkerMiddlewareConfig): PolicyRegistration[] {
  if (config.policyPlan) {
    return resolvePoliciesFromPlan(config.policyPlan);
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

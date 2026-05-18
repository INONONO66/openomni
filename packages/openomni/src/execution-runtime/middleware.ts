import {
  createBudgetReassurancePolicy,
  createBudgetWarningPolicy,
  createCompactionPolicy,
  createIdleNudgePolicy,
  createToolPermissionPolicy,
  defaultRegistry,
} from "@openomni/agent";
import type { ChatAgentConfig, PolicyRegistration } from "@openomni/agent";
import { Policy } from "@openomni/protocol";

export interface WorkerMiddlewareConfig {
  permissions?: Policy.Permission;
  policyPlan?: Policy.PolicyPlan;
  compaction?: ChatAgentConfig["compaction"];
  eventEmitter?: ChatAgentConfig["eventEmitter"];
  source?: string;
  includeLifecycle?: boolean;
  includeIdle?: boolean;
}

const FAIL_CLOSED_TOOL_PERMISSION: Policy.Permission = { action: "tool.call", denylist: ["*"] };
const DEFAULT_TOOL_PERMISSION: Policy.Permission = { action: "tool.call" };

export function buildWorkerMiddleware(config: WorkerMiddlewareConfig): PolicyRegistration[] {
  const policyPlanMiddleware = config.policyPlan
    ? resolvePoliciesFromPlan(hydrateToolPermissionConfig(config.policyPlan, config))
    : undefined;
  const lifecycleMiddleware =
    config.includeLifecycle === false
      ? []
      : registrationsAbsentFrom(
          buildAgentLifecycleMiddleware(config.compaction),
          policyPlanMiddleware ?? [],
        );

  return [
    ...lifecycleMiddleware,
    ...(policyPlanMiddleware ?? buildLegacyPermissionMiddleware(config)),
    ...(shouldAppendIdleNudge(config, policyPlanMiddleware) ? [createIdleNudgePolicy()] : []),
  ];
}

function shouldAppendIdleNudge(
  config: WorkerMiddlewareConfig,
  policyPlanMiddleware: PolicyRegistration[] | undefined,
): boolean {
  if (config.includeIdle === false) return false;
  return !policyPlanMiddleware?.some((registration) => registration.name === "builtin:idle-nudge");
}

export function buildAgentLifecycleMiddleware(
  compaction: ChatAgentConfig["compaction"],
): PolicyRegistration[] {
  return [
    createBudgetReassurancePolicy(),
    createBudgetWarningPolicy(),
    ...(compaction ? [createCompactionPolicy(compaction)] : []),
  ];
}

export function registrationsAbsentFrom(
  registrations: PolicyRegistration[],
  existing: PolicyRegistration[],
): PolicyRegistration[] {
  const existingNames = new Set(existing.map((registration) => registration.name));
  return registrations.filter((registration) => !existingNames.has(registration.name));
}

function buildLegacyPermissionMiddleware(config: WorkerMiddlewareConfig): PolicyRegistration[] {
  return [
    createToolPermissionPolicy({
      permission: config.permissions ?? DEFAULT_TOOL_PERMISSION,
      ...(config.eventEmitter !== undefined && { eventEmitter: config.eventEmitter }),
      source: config.source ?? "stream-engine",
    }),
  ];
}

function resolvePoliciesFromPlan(plan: Policy.PolicyPlan): PolicyRegistration[] {
  const registry = defaultRegistry();
  return registry.resolve(plan, {});
}

export function resolvePolicyPlanToolPermission(
  plan: Policy.PolicyPlan | undefined,
  fallbackPermission: Policy.Permission | undefined,
): Policy.Permission | undefined {
  if (!plan) return fallbackPermission;
  const toolPermissionPolicy = plan.policies.find(
    (policy) => policy.id === "builtin:tool-permission",
  );
  if (!toolPermissionPolicy) return undefined;
  return resolveToolPermissionConfig(toolPermissionPolicy.config ?? {}, fallbackPermission);
}

function resolveToolPermissionConfig(
  config: Record<string, unknown>,
  fallbackPermission: Policy.Permission | undefined,
): Policy.Permission {
  if (!("permission" in config)) return fallbackPermission ?? DEFAULT_TOOL_PERMISSION;
  const parsed = Policy.Permission.safeParse(config.permission);
  return parsed.success ? parsed.data : FAIL_CLOSED_TOOL_PERMISSION;
}

function hydrateToolPermissionConfig(
  plan: Policy.PolicyPlan,
  workerConfig: WorkerMiddlewareConfig,
): Policy.PolicyPlan {
  const fallbackPermission = workerConfig.permissions ?? DEFAULT_TOOL_PERMISSION;
  let changed = false;
  const policies = plan.policies.map((policy) => {
    if (policy.id !== "builtin:tool-permission") return policy;
    const config = policy.config ?? {};
    const hydratedConfig = hydrateToolPermissionObservability(config, workerConfig);
    if (hydratedConfig !== config) changed = true;
    // Keep legacy permissions effective for policy plans that select the
    // builtin guard without owning its config yet.
    // A present-but-invalid permission is treated as explicit and fails closed.
    if ("permission" in hydratedConfig) {
      if (Policy.Permission.safeParse(hydratedConfig.permission).success) {
        return hydratedConfig === config ? policy : { ...policy, config: hydratedConfig };
      }
      changed = true;
      return {
        ...policy,
        config: { ...hydratedConfig, permission: FAIL_CLOSED_TOOL_PERMISSION },
      };
    }

    changed = true;
    return {
      ...policy,
      config: {
        ...hydratedConfig,
        permission: fallbackPermission,
      },
    };
  });

  return changed ? { ...plan, policies } : plan;
}

function hydrateToolPermissionObservability(
  config: Record<string, unknown>,
  workerConfig: WorkerMiddlewareConfig,
): Record<string, unknown> {
  const additions: Record<string, unknown> = {};
  if (workerConfig.eventEmitter !== undefined && !("eventEmitter" in config)) {
    additions.eventEmitter = workerConfig.eventEmitter;
  }
  if (!("source" in config)) {
    additions.source = workerConfig.source ?? "stream-engine";
  }
  return Object.keys(additions).length === 0 ? config : { ...config, ...additions };
}

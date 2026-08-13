import {
  createBudgetReassurancePolicy,
  createBudgetWarningPolicy,
  createCompactionPolicy,
  createIdleNudgePolicy,
  createToolPermissionPolicy,
  defaultRegistry,
} from "@openomni/agent";
import type { PolicyEngineRegistration } from "@openomni/agent";
import { Bus } from "@openomni/telemetry";
import { Policy } from "@openomni/protocol";
import type { Message } from "@openomni/protocol";
import type { InjectionQueue } from "./injection-queue.js";
import { createInjectionQueueDrainPolicy } from "./middleware/injection-queue-policy.js";

type WorkerCompactionConfig = {
  readonly contextWindowTokens: number;
  readonly thresholdRatio?: number;
  readonly reserveTokens?: number;
  readonly reserveRatio?: number;
  readonly protectRecentMessages?: number;
  readonly onSummarize?: (messages: Message.WithParts[]) => Promise<string>;
};

export interface WorkerMiddlewareConfig {
  permissions?: Policy.Permission;
  policyPlan?: Policy.PolicyPlan;
  /**
   * The trace of the run these policies are being resolved for. Resolution
   * reports a missing optional policy, and that report is filed under this
   * trace or not at all — the registry never mints one.
   */
  traceId?: string;
  compaction?: WorkerCompactionConfig;
  includeLifecycle?: boolean;
  includeIdle?: boolean;
  injectionQueue?: InjectionQueue.Instance;
}

const FAIL_CLOSED_TOOL_PERMISSION: Policy.Permission = { action: "tool.call", denylist: ["*"] };
const DEFAULT_TOOL_PERMISSION: Policy.Permission = { action: "tool.call" };

export function buildWorkerMiddleware(config: WorkerMiddlewareConfig): PolicyEngineRegistration[] {
  const policyPlanMiddleware = config.policyPlan
    ? resolvePoliciesFromPlan(hydrateToolPermissionConfig(config.policyPlan, config), config)
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
    ...(config.injectionQueue ? [createInjectionQueueDrainPolicy(config.injectionQueue)] : []),
    ...(shouldAppendIdleNudge(config, policyPlanMiddleware) ? [createIdleNudgePolicy()] : []),
  ];
}

function shouldAppendIdleNudge(
  config: WorkerMiddlewareConfig,
  policyPlanMiddleware: PolicyEngineRegistration[] | undefined,
): boolean {
  if (config.includeIdle === false) return false;
  return !policyPlanMiddleware?.some((registration) => registration.name === "builtin:idle-nudge");
}

function buildAgentLifecycleMiddleware(
  compaction: WorkerMiddlewareConfig["compaction"],
): PolicyEngineRegistration[] {
  return [
    createBudgetReassurancePolicy(),
    createBudgetWarningPolicy(),
    ...(compaction ? [createCompactionPolicy(compaction)] : []),
  ];
}

function registrationsAbsentFrom(
  registrations: PolicyEngineRegistration[],
  existing: PolicyEngineRegistration[],
): PolicyEngineRegistration[] {
  const existingNames = new Set(existing.map((registration) => registration.name));
  return registrations.filter((registration) => !existingNames.has(registration.name));
}

function buildLegacyPermissionMiddleware(
  config: WorkerMiddlewareConfig,
): PolicyEngineRegistration[] {
  return [
    createToolPermissionPolicy({
      permission: config.permissions ?? DEFAULT_TOOL_PERMISSION,
    }),
  ];
}

function resolvePoliciesFromPlan(
  plan: Policy.PolicyPlan,
  config: WorkerMiddlewareConfig,
): PolicyEngineRegistration[] {
  const registry = defaultRegistry();
  return registry.resolve(
    plan,
    config.traceId === undefined ? {} : { traceId: config.traceId, auditEmit: Bus.publish },
  );
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
    // Keep legacy permissions effective for policy plans that select the
    // builtin guard without owning its config yet.
    // A present-but-invalid permission is treated as explicit and fails closed.
    if ("permission" in config) {
      if (Policy.Permission.safeParse(config.permission).success) return policy;
      changed = true;
      return { ...policy, config: { ...config, permission: FAIL_CLOSED_TOOL_PERMISSION } };
    }

    changed = true;
    return { ...policy, config: { ...config, permission: fallbackPermission } };
  });

  return changed ? { ...plan, policies } : plan;
}

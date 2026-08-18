import { createCompactionPolicy, PolicyRegistry } from "@openomni/agent";
import type { PolicyContext, PolicyEngineRegistration } from "@openomni/agent";
import { Bus } from "@openomni/telemetry";
import { Policy } from "@openomni/protocol";
import type { Message } from "@openomni/protocol";
import type { InjectionQueue } from "./injection-queue.js";
import { createInjectionQueueDrainPolicy } from "./middleware/injection-queue-policy.js";
import { createIdleNudgePolicy, registerIdleNudge } from "./middleware/idle-nudge-policy.js";
import { COMPACTION_PRIORITY, registerCompaction } from "./middleware/compaction-policy.js";
import { anchorSummarizer, type CompletionFn } from "./middleware/anchor-summarizer.js";
import {
  createBudgetReassurancePolicy,
  createBudgetWarningPolicy,
  registerBudgetNudges,
} from "./middleware/budget-nudge-policy.js";
import {
  createToolPermissionPolicy,
  registerToolPermission,
} from "./middleware/tool-permission-policy.js";

type WorkerCompactionConfig = {
  readonly contextWindowTokens?: number;
  readonly thresholdRatio?: number;
  readonly reserveTokens?: number;
  readonly reserveRatio?: number;
  readonly protectRecentMessages?: number;
  readonly preserveUserMessageChars?: number;
  readonly onSummarize?: (
    messages: Message.WithParts[],
    previousAnchor?: string,
  ) => Promise<string>;
  /**
   * Convenience over `onSummarize`: a bare completion function (host wires
   * it to the run's model, D7) that this module turns into the canonical
   * anchored summarizer. `onSummarize` wins when both are set.
   */
  readonly summarizeWith?: CompletionFn;
  readonly elideToolOutputs?: { minOutputChars: number; keepHeadChars: number };
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

/**
 * The product's default compaction strategy (#606 wiring ruling): the window
 * itself is the loop's fact — the resolved model's limit — so the default
 * carries only opinions. Elision knobs: outputs under ~1k tokens are not
 * worth rewriting history for, and half a k of head keeps the record legible.
 * No summarizer by default — the boundary-snap cut is deterministic and
 * needs no LLM. Hosts opt out or override by passing their own block.
 */
const DEFAULT_WORKER_COMPACTION: WorkerCompactionConfig = {
  elideToolOutputs: { minOutputChars: 4000, keepHeadChars: 500 },
};

function buildAgentLifecycleMiddleware(
  compaction: WorkerMiddlewareConfig["compaction"],
): PolicyEngineRegistration[] {
  const { summarizeWith, ...rest } = compaction ?? DEFAULT_WORKER_COMPACTION;
  const summarizer =
    rest.onSummarize ?? (summarizeWith === undefined ? undefined : anchorSummarizer(summarizeWith));
  return [
    createBudgetReassurancePolicy(),
    createBudgetWarningPolicy(),
    createCompactionPolicy({
      ...rest,
      ...(summarizer === undefined ? {} : { onSummarize: summarizer }),
      events: Bus,
      priority: COMPACTION_PRIORITY,
    }),
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
      events: Bus,
    }),
  ];
}

function resolvePoliciesFromPlan(
  plan: Policy.PolicyPlan,
  config: WorkerMiddlewareConfig,
): PolicyEngineRegistration[] {
  const registry = PolicyRegistry.create<PolicyContext>();
  registerCompaction(registry, Bus);
  registerIdleNudge(registry);
  registerBudgetNudges(registry);
  registerToolPermission(registry, Bus);
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

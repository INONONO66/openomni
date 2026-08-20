import { createCompactionPolicy, PolicyRegistry } from "@openomni/agent";
import type { PolicyContext, PolicyEngineRegistration } from "@openomni/agent";
import { Bus } from "@openomni/telemetry";
import { Policy } from "@openomni/protocol";
import type { Message } from "@openomni/protocol";
import type { InjectionQueue } from "./injection-queue.js";
import { createInjectionQueueDrainPolicy } from "./middleware/injection-queue-policy.js";
import { createIdleNudgePolicy, registerIdleNudge } from "./middleware/idle-nudge-policy.js";
import {
  COMPACTION_PRIORITY,
  registerCompaction,
  withReplacementPersistence,
} from "./middleware/compaction-policy.js";
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
  readonly speculate?: false | { prepareRatio?: number };
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

/**
 * 고도화 A — a tier→tool-set permission cap expressed as an ADDITIVE deny-label
 * overlay (never a name enumeration, never a permission replacement). The
 * Owner declares, as DATA, that a trust tier's tools are capped by capability
 * (`capability:write` / `capability:destructive` / `capability:read`, stamped
 * by `defineTool`); the overlay's `denyLabels` union into the effective
 * permission's `denyLabels`, so the deny-wins ordering caps the tier WITHOUT
 * discarding the agent's own allowlist/denylist. Absent overlay → no
 * relaxation change (base behavior).
 */
export interface TierDenyOverlay {
  readonly denyLabels: readonly string[];
}

export interface WorkerMiddlewareConfig {
  permissions?: Policy.Permission;
  policyPlan?: Policy.PolicyPlan;
  /**
   * 고도화 A — the resolved deny-label overlay for the triggering delivery's
   * trust tier (looked up from the injected profiles table by the resident
   * runtime). Composes AFTER the S6 `evidence_only` cap: evidence_only still
   * short-circuits to deny-all; only a `full_access` turn gets the overlay
   * merged onto its base permission. Absent for tiers with no profile entry
   * (owner/co_owner/manager by default) and for runs with no trust tier
   * (internal / wait-resumption / anonymous).
   */
  tierDenyOverlay?: TierDenyOverlay;
  /**
   * The trace of the run these policies are being resolved for. Resolution
   * reports a missing optional policy, and that report is filed under this
   * trace or not at all — the registry never mints one.
   */
  traceId?: string;
  /**
   * S6 hard authority gate — the triggering delivery's perimeter inbound
   * treatment (Gateway.ActorContext.inboundTreatment, verbatim). When
   * `"evidence_only"`, this run's tool permission is forced to deny-all,
   * OVERRIDING whatever `permissions` / the plan's `builtin:tool-permission`
   * would allow: an untrusted-actor turn (laundered/blacklisted replay,
   * broadcast stranger) may inform the resident's reasoning but must not drive
   * tool use. A `full_access`/absent treatment is untouched (acts normally).
   */
  inboundTreatment?: string;
  compaction?: WorkerCompactionConfig;
  includeLifecycle?: boolean;
  includeIdle?: boolean;
  injectionQueue?: InjectionQueue.Instance;
}

/**
 * The ONLY permission this module ever mints (audit batch A): an absent
 * permission is a composition bug, never an implicit allow-all. Production
 * paths declare their ruleset explicitly — the dispatch gate's PolicyResolver
 * stamps `config.permission` onto the plan's `builtin:tool-permission`, and
 * the server's agent composition sets `permissions` on every AgentDef.
 */
const FAIL_CLOSED_TOOL_PERMISSION: Policy.Permission = { action: "tool.call", denylist: ["*"] };

/**
 * S6 hard authority gate: an `evidence_only` inbound caps the run's tool
 * permission to deny-all, whatever `permissions`/the plan would otherwise
 * allow. This is the load-bearing half of S6 (the projector's evidence
 * framing is defense-in-depth): evidence informs the resident's reasoning but
 * cannot act on that turn.
 */
function isEvidenceOnly(config: WorkerMiddlewareConfig): boolean {
  return config.inboundTreatment === "evidence_only";
}

/**
 * 고도화 A additive-deny merge: union the tier overlay's `denyLabels` into the
 * effective permission, preserving everything else (allowlist/denylist/rules)
 * so the cap tightens WITHOUT replacing the agent's own ruleset. A no-op
 * overlay (absent or empty) returns the permission unchanged by reference, so
 * callers can cheaply detect "nothing changed".
 */
function applyTierDenyOverlay(
  permission: Policy.Permission,
  overlay: TierDenyOverlay | undefined,
): Policy.Permission {
  if (overlay === undefined || overlay.denyLabels.length === 0) return permission;
  const merged = [...new Set([...(permission.denyLabels ?? []), ...overlay.denyLabels])];
  return { ...permission, denyLabels: merged };
}

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
 * Elision knobs only in the DEFAULT block; the summarizer arrives from the
 * host (worker-runner / resident wire createAnchorCompletion — Owner ruling
 * 2026-08-19: summarization enabled by default in production, superseding
 * #649's elision-only default). Hosts opt out with `speculate: false` +
 * omitting the summarizer, or override any knob; partials merge.
 */
const DEFAULT_WORKER_COMPACTION: WorkerCompactionConfig = {
  elideToolOutputs: { minOutputChars: 4000, keepHeadChars: 500 },
};

function buildAgentLifecycleMiddleware(
  compaction: WorkerMiddlewareConfig["compaction"],
): PolicyEngineRegistration[] {
  // Partial configs MERGE over the defaults: a host that only wires a
  // summarizer must not silently lose the elision knobs (and vice versa).
  const provided = Object.fromEntries(
    Object.entries(compaction ?? {}).filter(([, value]) => value !== undefined),
  ) as NonNullable<WorkerMiddlewareConfig["compaction"]>;
  const { summarizeWith, ...rest } = { ...DEFAULT_WORKER_COMPACTION, ...provided };
  const summarizer =
    rest.onSummarize ?? (summarizeWith === undefined ? undefined : anchorSummarizer(summarizeWith));
  return [
    createBudgetReassurancePolicy(),
    createBudgetWarningPolicy(),
    withReplacementPersistence(
      createCompactionPolicy({
        ...rest,
        ...(summarizer === undefined ? {} : { onSummarize: summarizer }),
        events: Bus,
        priority: COMPACTION_PRIORITY,
      }),
      Bus,
    ),
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
      // No plan and no legacy permissions: nothing declared a ruleset for
      // this run, so the guard denies every tool instead of allowing all.
      // Composition order: evidence_only cap (deny-all, S6) → tier deny-overlay
      // → agent base permission. evidence_only short-circuits; only a
      // full_access turn gets the tier overlay merged onto its base.
      permission: isEvidenceOnly(config)
        ? FAIL_CLOSED_TOOL_PERMISSION
        : applyTierDenyOverlay(
            config.permissions ?? FAIL_CLOSED_TOOL_PERMISSION,
            config.tierDenyOverlay,
          ),
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
  const evidenceOnly = isEvidenceOnly(workerConfig);
  const overlay = workerConfig.tierDenyOverlay;
  const fallbackPermission = workerConfig.permissions ?? FAIL_CLOSED_TOOL_PERMISSION;
  let changed = false;
  const policies = plan.policies.map((policy) => {
    if (policy.id !== "builtin:tool-permission") return policy;
    const config = policy.config ?? {};
    // Composition order: evidence_only cap (deny-all, S6) → tier deny-overlay
    // → the plan's/legacy ruleset. The S6 hard gate short-circuits FIRST:
    // an evidence_only run's tool authority is capped to deny-all, OVERRIDING
    // whatever ruleset the plan declares and skipping the tier overlay.
    if (evidenceOnly) {
      changed = true;
      return { ...policy, config: { ...config, permission: FAIL_CLOSED_TOOL_PERMISSION } };
    }
    // Keep legacy permissions effective for policy plans that select the
    // builtin guard without owning its config yet. With no legacy permissions
    // either, the absent arm fails CLOSED (deny-all): a plan that selects the
    // guard without a ruleset gets no implicit allow-all.
    // A present-but-invalid permission is treated as explicit and fails closed.
    // 고도화 A: a full_access turn merges the tier deny-overlay onto the
    // effective permission (additive deny, deny-wins preserved).
    if ("permission" in config) {
      const parsed = Policy.Permission.safeParse(config.permission);
      if (parsed.success) {
        const overlaid = applyTierDenyOverlay(parsed.data, overlay);
        if (overlaid === parsed.data) return policy;
        changed = true;
        return { ...policy, config: { ...config, permission: overlaid } };
      }
      changed = true;
      return { ...policy, config: { ...config, permission: FAIL_CLOSED_TOOL_PERMISSION } };
    }

    changed = true;
    return {
      ...policy,
      config: { ...config, permission: applyTierDenyOverlay(fallbackPermission, overlay) },
    };
  });

  return changed ? { ...plan, policies } : plan;
}

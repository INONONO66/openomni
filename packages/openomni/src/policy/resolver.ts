import type { Policy } from "@openomni/protocol";

/**
 * The gate's explicit tool-permission ruleset for spawned runs (#462 §7,
 * audit batch A). This allow-by-default decision used to live as an implicit
 * hydration fallback deep in the execution runtime; the runtime now fails
 * CLOSED on an absent permission, so the gate DECLARES its ruleset here and
 * stamps it into the plan, where it is recorded and auditable. Deployments
 * that want a tighter default pass `toolPermission` to
 * {@link PolicyResolver.create}.
 */
const GATE_DEFAULT_TOOL_PERMISSION: Policy.Permission = { action: "tool.call" };

type LabelInput = string | Policy.LabelEntry;

export interface ResolverContext {
  readonly actorLabels: readonly LabelInput[];
  readonly agentLabels: readonly LabelInput[];
  readonly runLabels: readonly LabelInput[];
  readonly surfaceLabels: readonly LabelInput[];
}

export interface LabelMatcher {
  readonly all?: readonly string[];
  readonly any?: readonly string[];
  readonly none?: readonly string[];
}

export interface PolicyResolverRule {
  readonly match: LabelMatcher;
  readonly policies: readonly string[];
  readonly required?: boolean;
}

export interface PolicyResolverInstance {
  resolve(context: ResolverContext): Policy.PolicyPlan;
}

function labelValue(label: LabelInput): string {
  return typeof label === "string" ? label : label.value;
}

function uniqueLabels(context: ResolverContext): string[] {
  const labels = new Set<string>();
  for (const label of [
    ...context.actorLabels,
    ...context.agentLabels,
    ...context.runLabels,
    ...context.surfaceLabels,
  ]) {
    labels.add(labelValue(label));
  }
  return [...labels];
}

function hasAny(labels: ReadonlySet<string>, expected: readonly string[] | undefined): boolean {
  return expected?.some((label) => labels.has(label)) ?? false;
}

function matchesLabels(matcher: LabelMatcher, labels: ReadonlySet<string>): boolean {
  if (matcher.all?.some((label) => !labels.has(label))) return false;
  if (matcher.any !== undefined && !hasAny(labels, matcher.any)) return false;
  if (hasAny(labels, matcher.none)) return false;
  return true;
}

function addPolicies(
  plan: Map<string, Policy.PolicyPlan["policies"][number]>,
  policyIds: readonly string[],
  required: boolean,
): void {
  for (const id of policyIds) {
    const existing = plan.get(id);
    // Rules carry ids only — a rule re-selecting a default policy must not
    // strip the config the default entry declared (the stamped permission).
    plan.set(id, {
      id,
      required: existing?.required || required,
      ...(existing?.config === undefined ? {} : { config: existing.config }),
    });
  }
}

class StaticPolicyResolver implements PolicyResolverInstance {
  constructor(
    private readonly rules: readonly PolicyResolverRule[],
    private readonly toolPermission: Policy.Permission,
  ) {}

  resolve(context: ResolverContext): Policy.PolicyPlan {
    const labels = uniqueLabels(context);
    const labelSet = new Set(labels);
    const policies = new Map<string, Policy.PolicyPlan["policies"][number]>();

    // The default guard set travels WITH its config: downstream hydration
    // fails closed on an absent permission, so the plan must carry the
    // gate's explicit ruleset instead of relying on any runtime default.
    policies.set("builtin:tool-permission", {
      id: "builtin:tool-permission",
      required: true,
      config: { permission: this.toolPermission },
    });
    policies.set("builtin:idle-nudge", { id: "builtin:idle-nudge", required: true });

    for (const rule of this.rules) {
      if (matchesLabels(rule.match, labelSet)) {
        addPolicies(policies, rule.policies, rule.required ?? false);
      }
    }

    return { policies: [...policies.values()], labels };
  }
}

export namespace PolicyResolver {
  export function create(
    rules: readonly PolicyResolverRule[] = [],
    /** `toolPermission`: the gate's ruleset stamped onto every resolved plan. */
    options: { readonly toolPermission?: Policy.Permission } = {},
  ): PolicyResolverInstance {
    return new StaticPolicyResolver(rules, options.toolPermission ?? GATE_DEFAULT_TOOL_PERMISSION);
  }
}

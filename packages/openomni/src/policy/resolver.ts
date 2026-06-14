import type { Policy } from "@openomni/protocol";

const defaultPolicyIds = ["builtin:tool-permission", "builtin:idle-nudge"];

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
    plan.set(id, { id, required: existing?.required || required });
  }
}

class StaticPolicyResolver implements PolicyResolverInstance {
  constructor(private readonly rules: readonly PolicyResolverRule[]) {}

  resolve(context: ResolverContext): Policy.PolicyPlan {
    const labels = uniqueLabels(context);
    const labelSet = new Set(labels);
    const policies = new Map<string, Policy.PolicyPlan["policies"][number]>();

    addPolicies(policies, defaultPolicyIds, true);

    for (const rule of this.rules) {
      if (matchesLabels(rule.match, labelSet)) {
        addPolicies(policies, rule.policies, rule.required ?? false);
      }
    }

    return { policies: [...policies.values()], labels };
  }
}

export namespace PolicyResolver {
  export function create(rules: readonly PolicyResolverRule[] = []): PolicyResolverInstance {
    return new StaticPolicyResolver(rules);
  }
}

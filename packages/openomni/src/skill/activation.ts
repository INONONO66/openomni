import type { PolicyRegistration } from "@openomni/agent";
import { type Policy, PolicyDecision, Skill } from "@openomni/protocol";

const layerOrder: Record<Skill.Layer, number> = {
  execution: 0,
  enhancement: 1,
  guarantee: 2,
};

export interface SkillActivationMiddlewareOptions {
  readonly name?: string;
  readonly priority?: number;
  readonly scope?: Policy.Scope;
  readonly propagate?: boolean;
}

export function createSkillActivationMiddleware(
  skills: readonly Skill.Definition[],
  options: SkillActivationMiddlewareOptions = {},
): PolicyRegistration {
  const activeSkills = sortSkills(Skill.Definition.array().parse(skills));

  return {
    name: options.name ?? "skill:activation",
    timing: "context.prepare",
    priority: options.priority ?? 90,
    ...(options.scope !== undefined && { scope: options.scope }),
    ...(options.propagate !== undefined && { propagate: options.propagate }),
    fn: () => activationDecision(activeSkills),
  };
}

function activationDecision(skills: readonly Skill.Definition[]): Policy.PolicyDecision {
  if (skills.length === 0) {
    return PolicyDecision.allow({
      policyId: "skill.activation",
      reasonCodes: ["no active skills"],
    });
  }

  const conflicts = findConflicts(skills);
  return PolicyDecision.allow({
    policyId: conflicts.length > 0 ? "skill.activation.conflict" : "skill.activation",
    reasonCodes: [composeReason(skills, conflicts)],
    effects: [{ type: "prompt.inject_message", message: composePrompt(skills) }],
  });
}

function sortSkills(skills: readonly Skill.Definition[]): Skill.Definition[] {
  return [...skills].sort((a, b) => {
    const layerComparison = layerOrder[a.layer] - layerOrder[b.layer];
    return layerComparison === 0 ? a.id.localeCompare(b.id) : layerComparison;
  });
}

function findConflicts(skills: readonly Skill.Definition[]): string[] {
  const executionIds = skills
    .filter((skill) => skill.layer === "execution")
    .map((skill) => skill.id);

  return executionIds.length > 1 ? [`multiple execution skills (${executionIds.join(", ")})`] : [];
}

function composePrompt(skills: readonly Skill.Definition[]): string {
  const fragments = skills.map((skill) => {
    const fragment = skill.promptFragment.trim() || skill.description.trim();
    return [`[${skill.layer}:${skill.id}] ${skill.name}`, fragment].join("\n");
  });

  return [
    "[Skill Activation]",
    "Apply these active skill prompt fragments in order.",
    ...fragments,
  ].join("\n\n");
}

function composeReason(skills: readonly Skill.Definition[], conflicts: readonly string[]): string {
  const base = `composed skill prompt fragments: ${skills.map((skill) => skill.id).join(", ")}`;
  if (conflicts.length === 0) {
    return base;
  }

  return `${base}; conflict: ${conflicts.join("; ")}`;
}

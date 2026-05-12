import type { PolicyRegistration } from "@openomni/agent";
import { type Policy, Skill } from "@openomni/protocol";

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
    timing: "on_system_prompt",
    priority: options.priority ?? 90,
    ...(options.scope !== undefined && { scope: options.scope }),
    ...(options.propagate !== undefined && { propagate: options.propagate }),
    fn: () => activationVerdict(activeSkills),
  };
}

function activationVerdict(skills: readonly Skill.Definition[]): Policy.Verdict {
  if (skills.length === 0) {
    return {
      action: "continue",
      policyId: "skill.activation",
      reason: "no active skills",
    };
  }

  const conflicts = findConflicts(skills);
  return {
    action: "inject",
    message: composePrompt(skills),
    policyId: conflicts.length > 0 ? "skill.activation.conflict" : "skill.activation",
    reason: composeReason(skills, conflicts),
  };
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

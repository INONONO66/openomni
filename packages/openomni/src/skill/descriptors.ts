import type { RuntimeResource, Skill } from "@openomni/protocol";
import type { SkillOrigin } from "./shared";

export function attachRuntimeDescriptors(
  definition: Skill.Definition,
  origin: SkillOrigin,
  mcpTools: readonly string[],
): Skill.Definition {
  Object.defineProperties(definition, {
    descriptor: {
      value: createSkillDescriptor(definition, origin),
      enumerable: false,
    },
    mcpToolDescriptors: {
      value: mcpTools.map((toolName) => createSkillMcpToolDescriptor(definition.id, toolName)),
      enumerable: false,
    },
  });

  return definition;
}

function createSkillDescriptor(
  definition: Skill.Definition,
  origin: SkillOrigin,
): RuntimeResource.Descriptor {
  return {
    id: `skill:${definition.id}`,
    kind: "skill",
    labels: [`source.${origin}`, `skill.layer.${definition.layer}`],
    capabilities: ["behavior.inject"],
    effects: ["prompt.modify"],
    source: skillDescriptorSource(origin, definition),
  };
}

function skillDescriptorSource(
  origin: SkillOrigin,
  definition: Skill.Definition,
): RuntimeResource.Source {
  switch (origin) {
    case "project":
      return { type: "project", path: definition.path };
    case "user":
      return { type: "user" };
    case "global":
      return { type: "global", scope: "skill" };
  }
}

function createSkillMcpToolDescriptor(
  skillId: string,
  toolName: string,
): RuntimeResource.Descriptor {
  return {
    id: `tool:skill-mcp:${toolName.split(":").join("/")}`,
    kind: "tool",
    labels: ["source.skill-mcp", `skill.${skillId}`],
    capabilities: ["tool.invoke"],
    effects: ["external.read"],
    source: {
      type: "skill-mcp",
      skillId,
      remoteName: toolName,
    },
  };
}

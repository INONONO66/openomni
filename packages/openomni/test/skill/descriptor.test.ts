import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Skill, type RuntimeResource } from "@openomni/protocol";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillLoader, SkillRegistry } from "../../src/skill";

let testRoot: string;
let projectRoot: string;
let homeRoot: string;

describe("SkillLoader runtime descriptors", () => {
  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "openomni-skill-descriptor-"));
    projectRoot = join(testRoot, "project");
    homeRoot = join(testRoot, "home");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(homeRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  test("attaches project-origin descriptors to loaded local skills", async () => {
    await writeSkill(join(projectRoot, ".openomni", "skills"), "git-master", "enhancement");

    const skill = await SkillLoader.loadLocal("git-master", { projectRoot });

    expect(runtimeDescriptor(skill)).toMatchObject({
      id: "skill:git-master",
      kind: "skill",
      labels: ["source.project", "skill.layer.enhancement"],
      capabilities: ["behavior.inject"],
      effects: ["prompt.modify"],
      source: { type: "project" },
    });
    expect(Object.keys(skill)).not.toContain("descriptor");
    expect(SkillDefinitionParse(skill)).toEqual(skill);
  });

  test("attaches global-origin descriptors during global discovery", async () => {
    await writeSkill(join(homeRoot, ".openomni", "skills"), "review-work", "guarantee");
    await SkillRegistry.write(
      [
        {
          id: "review-work",
          version: "1.0.0",
          installedAt: 1_714_800_000_000,
          enabled: true,
        },
      ],
      { homeRoot },
    );

    const [skill] = await SkillLoader.discoverGlobal({ homeRoot });

    expect(runtimeDescriptor(requireSkill(skill))).toMatchObject({
      id: "skill:review-work",
      kind: "skill",
      labels: ["source.global", "skill.layer.guarantee"],
      capabilities: ["behavior.inject"],
      effects: ["prompt.modify"],
      source: { type: "global" },
    });
  });

  test("attaches skill-mcp source descriptors for skill-provided MCP tools", async () => {
    await writeSkill(join(projectRoot, ".openomni", "skills"), "content-research", "enhancement", {
      mcpTools: ["github.create_issue", "linear.create_issue"],
    });

    const skill = await SkillLoader.loadLocal("content-research", { projectRoot });

    expect(mcpToolDescriptors(skill)).toEqual([
      {
        id: "tool:skill-mcp:github.create_issue",
        kind: "tool",
        labels: ["source.skill-mcp", "skill.content-research"],
        capabilities: ["tool.invoke"],
        effects: ["external.read"],
        source: {
          type: "skill-mcp",
          skillId: "content-research",
          remoteName: "github.create_issue",
        },
      },
      {
        id: "tool:skill-mcp:linear.create_issue",
        kind: "tool",
        labels: ["source.skill-mcp", "skill.content-research"],
        capabilities: ["tool.invoke"],
        effects: ["external.read"],
        source: {
          type: "skill-mcp",
          skillId: "content-research",
          remoteName: "linear.create_issue",
        },
      },
    ]);
    expect(Object.keys(skill)).not.toContain("mcpToolDescriptors");
  });
});

type SkillWithRuntimeDescriptors = Skill.Definition & {
  readonly descriptor: RuntimeResource.Descriptor;
  readonly mcpToolDescriptors: readonly RuntimeResource.Descriptor[];
};

async function writeSkill(
  root: string,
  id: string,
  layer: Skill.Layer,
  options: { readonly mcpTools?: readonly string[] } = {},
): Promise<void> {
  const skillDir = join(root, id);
  await mkdir(skillDir, { recursive: true });
  const lines = [
    "---",
    `id: ${id}`,
    `name: ${id}`,
    `description: ${id} behavior`,
    `layer: ${layer}`,
  ];
  if (options.mcpTools) {
    lines.push("mcpTools:");
    for (const tool of options.mcpTools) {
      lines.push(`  - ${tool}`);
    }
  }
  lines.push("---", "", "Follow the skill behavior.", "");
  await Bun.write(join(skillDir, "SKILL.md"), lines.join("\n"));
}

function runtimeDescriptor(skill: Skill.Definition): RuntimeResource.Descriptor {
  return withRuntimeDescriptors(skill).descriptor;
}

function mcpToolDescriptors(skill: Skill.Definition): readonly RuntimeResource.Descriptor[] {
  return withRuntimeDescriptors(skill).mcpToolDescriptors;
}

function withRuntimeDescriptors(skill: Skill.Definition): SkillWithRuntimeDescriptors {
  expect("descriptor" in skill).toBe(true);
  expect("mcpToolDescriptors" in skill).toBe(true);
  return skill as SkillWithRuntimeDescriptors;
}

function requireSkill(skill: Skill.Definition | undefined): Skill.Definition {
  expect(skill).not.toBeUndefined();
  return skill as Skill.Definition;
}

function SkillDefinitionParse(skill: Skill.Definition): Skill.Definition {
  return Skill.Definition.parse(skill);
}

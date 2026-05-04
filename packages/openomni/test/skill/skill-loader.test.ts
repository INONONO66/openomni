import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Skill } from "@openomni/protocol";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillLoader, SkillRegistry } from "../../src/skill";

let testRoot: string;
let projectRoot: string;
let homeRoot: string;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "openomni-skill-"));
  projectRoot = join(testRoot, "project");
  homeRoot = join(testRoot, "home");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(homeRoot, { recursive: true });
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("SkillLoader", () => {
  it("discovers local project skills with local scope", async () => {
    await writeSkill(join(projectRoot, ".openomni", "skills"), "local-a", {
      name: "Local A",
      description: "Local project behavior",
      layer: "execution",
      body: "Use local project execution rules.",
      useWhen: "Use for project-specific execution",
      doNotUseWhen: "Do not use outside this project",
      finalChecklist: ["Verify local context", "Report concise output"],
    });

    const definitions = await SkillLoader.discoverLocal({ projectRoot });

    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      id: "local-a",
      name: "Local A",
      description: "Local project behavior",
      scope: "local",
      layer: "execution",
      promptFragment: "Use local project execution rules.",
      useWhen: "Use for project-specific execution",
      doNotUseWhen: "Do not use outside this project",
      finalChecklist: ["Verify local context", "Report concise output"],
    });
    expect(definitions[0]?.path).toBe(
      join(projectRoot, ".openomni", "skills", "local-a", "SKILL.md"),
    );
    expect(Skill.Definition.parse(definitions[0])).toEqual(definitions[0]);
  });

  it("discovers enabled global skills from the installed registry", async () => {
    await writeSkill(join(homeRoot, ".openomni", "skills"), "global-b", {
      name: "Global B",
      description: "Global reusable behavior",
      layer: "enhancement",
    });
    await writeSkill(join(homeRoot, ".openomni", "skills"), "global-a", {
      name: "Global A",
      description: "Another reusable behavior",
      layer: "guarantee",
    });
    await SkillRegistry.write([registryEntry("global-b", true), registryEntry("global-a", true)], {
      homeRoot,
    });

    const definitions = await SkillLoader.discoverGlobal({ homeRoot });

    expect(definitions.map((definition) => definition.id)).toEqual(["global-a", "global-b"]);
    expect(definitions.map((definition) => definition.scope)).toEqual(["global", "global"]);
    expect(definitions[0]).toMatchObject({
      id: "global-a",
      layer: "guarantee",
      path: join(homeRoot, ".openomni", "skills", "global-a", "SKILL.md"),
    });
    for (const definition of definitions) {
      expect(Skill.Definition.parse(definition)).toEqual(definition);
    }
  });

  it("skips disabled global registry entries", async () => {
    await writeSkill(join(homeRoot, ".openomni", "skills"), "enabled", {
      name: "Enabled",
      description: "Enabled skill",
      layer: "execution",
    });
    await writeSkill(join(homeRoot, ".openomni", "skills"), "disabled", {
      name: "Disabled",
      description: "Disabled skill",
      layer: "execution",
    });
    await SkillRegistry.write([registryEntry("disabled", false), registryEntry("enabled", true)], {
      homeRoot,
    });

    const definitions = await SkillLoader.discoverGlobal({ homeRoot });

    expect(definitions.map((definition) => definition.id)).toEqual(["enabled"]);
  });

  it("treats a missing global registry as empty discovery", async () => {
    const definitions = await SkillLoader.discoverGlobal({ homeRoot });

    expect(definitions).toEqual([]);
  });

  it("returns no local definitions when the local skills directory is missing", async () => {
    const definitions = await SkillLoader.discoverLocal({ projectRoot });

    expect(definitions).toEqual([]);
  });

  it("throws when an enabled global skill file is missing", async () => {
    await SkillRegistry.write([registryEntry("missing", true)], { homeRoot });

    await expectRejectsWithMessage(
      SkillLoader.discoverGlobal({ homeRoot }),
      "Skill file not found",
    );
  });

  it("throws when a skill definition is invalid", async () => {
    const skillPath = join(projectRoot, ".openomni", "skills", "broken", "SKILL.md");
    await mkdir(join(projectRoot, ".openomni", "skills", "broken"), { recursive: true });
    await Bun.write(
      skillPath,
      ["---", "id: broken", "name: Broken", "description: Missing layer", "---", ""].join("\n"),
    );

    await expectRejectsWithMessage(
      SkillLoader.loadLocal("broken", { projectRoot }),
      "Invalid skill definition",
    );
  });

  it("throws when a skill metadata id does not match its directory", async () => {
    const skillDir = join(projectRoot, ".openomni", "skills", "directory-id");
    await mkdir(skillDir, { recursive: true });
    await Bun.write(
      join(skillDir, "SKILL.md"),
      [
        "id: metadata-id",
        "name: Mismatched",
        "description: Mismatched id",
        "layer: execution",
      ].join("\n"),
    );

    await expectRejectsWithMessage(
      SkillLoader.loadLocal("directory-id", { projectRoot }),
      "does not match directory id",
    );
  });

  it("populates prompt fragments from markdown body and header metadata", async () => {
    await writeSkill(join(projectRoot, ".openomni", "skills"), "body-skill", {
      name: "Body Skill",
      description: "Body backed behavior",
      layer: "enhancement",
      body: ["# Body Skill", "", "Use the body as the prompt fragment."].join("\n"),
    });
    await writeSkill(join(projectRoot, ".openomni", "skills"), "header-skill", {
      name: "Header Skill",
      description: "Header backed behavior",
      layer: "guarantee",
      promptFragment: "Use the header prompt fragment.",
      body: "",
    });

    const bodySkill = await SkillLoader.loadLocal("body-skill", { projectRoot });
    const headerSkill = await SkillLoader.loadLocal("header-skill", { projectRoot });

    expect(bodySkill.promptFragment).toBe("# Body Skill\n\nUse the body as the prompt fragment.");
    expect(headerSkill.promptFragment).toBe("Use the header prompt fragment.");
    expect(Skill.Definition.parse(bodySkill)).toEqual(bodySkill);
    expect(Skill.Definition.parse(headerSkill)).toEqual(headerSkill);
  });
});

describe("SkillRegistry", () => {
  it("writes stable sorted registry JSON and reads protocol entries", async () => {
    const registryPath = join(homeRoot, ".openomni", "installed_skills.json");

    const written = await SkillRegistry.write(
      [registryEntry("zeta", true), registryEntry("alpha", false, "file:///alpha")],
      { registryPath },
    );

    expect(written.map((entry) => entry.id)).toEqual(["alpha", "zeta"]);
    expect(await Bun.file(registryPath).text()).toBe(`${JSON.stringify(written, null, 2)}\n`);

    const read = await SkillRegistry.read({ registryPath });
    expect(read).toEqual(written);
    for (const entry of read) {
      expect(Skill.RegistryEntry.parse(entry)).toEqual(entry);
    }
  });

  it("returns an empty registry when the registry file is missing", async () => {
    expect(await SkillRegistry.read({ homeRoot })).toEqual([]);
  });

  it("throws on malformed registry JSON", async () => {
    const registryPath = join(homeRoot, ".openomni", "installed_skills.json");
    await mkdir(join(homeRoot, ".openomni"), { recursive: true });
    await Bun.write(registryPath, "{not-json");

    await expectRejectsWithMessage(
      SkillRegistry.read({ registryPath }),
      "Failed to read skill registry",
    );
  });

  it("throws on registry records that do not match the protocol schema", async () => {
    const registryPath = join(homeRoot, ".openomni", "installed_skills.json");
    await mkdir(join(homeRoot, ".openomni"), { recursive: true });
    await Bun.write(registryPath, JSON.stringify([{ id: "broken", enabled: true }], null, 2));

    await expectRejectsWithMessage(SkillRegistry.read({ registryPath }), "Invalid skill registry");
  });
});

interface SkillFixture {
  readonly name: string;
  readonly description: string;
  readonly layer: Skill.Layer;
  readonly useWhen?: string;
  readonly doNotUseWhen?: string;
  readonly finalChecklist?: readonly string[];
  readonly promptFragment?: string;
  readonly body?: string;
}

async function writeSkill(root: string, id: string, fixture: SkillFixture): Promise<void> {
  const skillDir = join(root, id);
  await mkdir(skillDir, { recursive: true });
  await Bun.write(join(skillDir, "SKILL.md"), skillMarkdown(id, fixture));
}

function skillMarkdown(id: string, fixture: SkillFixture): string {
  const lines = [
    "---",
    `id: ${id}`,
    `name: ${fixture.name}`,
    `description: ${fixture.description}`,
    `layer: ${fixture.layer}`,
  ];

  if (fixture.useWhen) {
    lines.push(`useWhen: ${fixture.useWhen}`);
  }
  if (fixture.doNotUseWhen) {
    lines.push(`doNotUseWhen: ${fixture.doNotUseWhen}`);
  }
  if (fixture.finalChecklist) {
    lines.push("finalChecklist:");
    for (const item of fixture.finalChecklist) {
      lines.push(`  - ${item}`);
    }
  }
  if (fixture.promptFragment) {
    lines.push(`promptFragment: ${fixture.promptFragment}`);
  }

  lines.push("---", "", fixture.body ?? "Follow the skill-specific behavior.", "");

  return lines.join("\n");
}

function registryEntry(id: string, enabled: boolean, source?: string): Skill.RegistryEntry {
  return {
    id,
    version: "1.0.0",
    installedAt: 1_714_800_000_000,
    enabled,
    ...(source ? { source } : {}),
  };
}

async function expectRejectsWithMessage(promise: Promise<unknown>, message: string): Promise<void> {
  let caughtError: unknown;
  try {
    await promise;
  } catch (error) {
    caughtError = error;
  }

  expect(caughtError).toBeInstanceOf(Error);
  expect((caughtError as Error).message).toContain(message);
}

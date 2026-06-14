import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillLoader } from "../../src/context/skills";

type SkillMeta = ReturnType<typeof SkillLoader.discover>[number];

let tempRoot: string;
let emptyGlobalDir: string;

function makeWorkspace(root: string) {
  const skillsDir = join(root, ".openomni", "skills");
  mkdirSync(skillsDir, { recursive: true });
  return skillsDir;
}

function writeSkill(skillsDir: string, name: string, content: string) {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
}

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "skills-test-")));
  emptyGlobalDir = join(tempRoot, "empty-global");
  mkdirSync(emptyGlobalDir);
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("SkillLoader.discover", () => {
  it("discovers SKILL.md in .openomni/skills/my-skill/", () => {
    const ws = realpathSync(mkdtempSync(join(tempRoot, "test1-")));
    const skillsDir = makeWorkspace(ws);
    writeSkill(
      skillsDir,
      "my-skill",
      "---\nname: my-skill\ndescription: A test skill\n---\n# Content",
    );

    const skills = SkillLoader.discover(ws, emptyGlobalDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("my-skill");
    expect(skills[0].description).toBe("A test skill");
    expect(skills[0].path).toContain("SKILL.md");
  });

  it("parses frontmatter name and description correctly", () => {
    const ws = realpathSync(mkdtempSync(join(tempRoot, "test2-")));
    const skillsDir = makeWorkspace(ws);
    writeSkill(
      skillsDir,
      "dir-name",
      "---\nname: parsed-name\ndescription: Parsed description\n---\n# Body",
    );

    const skills = SkillLoader.discover(ws, emptyGlobalDir);

    expect(skills[0].name).toBe("parsed-name");
    expect(skills[0].description).toBe("Parsed description");
  });

  it("falls back to directory name when frontmatter has no name", () => {
    const ws = realpathSync(mkdtempSync(join(tempRoot, "test3-")));
    const skillsDir = makeWorkspace(ws);
    writeSkill(skillsDir, "dir-fallback", "---\ndescription: Only description\n---\n# Body");

    const skills = SkillLoader.discover(ws, emptyGlobalDir);

    expect(skills[0].name).toBe("dir-fallback");
    expect(skills[0].description).toBe("Only description");
  });

  it("falls back to empty description when frontmatter has no description", () => {
    const ws = realpathSync(mkdtempSync(join(tempRoot, "test4-")));
    const skillsDir = makeWorkspace(ws);
    writeSkill(skillsDir, "no-desc", "---\nname: no-desc\n---\n# Body");

    const skills = SkillLoader.discover(ws, emptyGlobalDir);

    expect(skills[0].description).toBe("");
  });

  it("handles malformed YAML frontmatter gracefully without crashing", () => {
    const ws = realpathSync(mkdtempSync(join(tempRoot, "test5-")));
    const skillsDir = makeWorkspace(ws);
    writeSkill(skillsDir, "bad-yaml", "---\nname: [unclosed bracket\ndescription: ok\n---\n# Body");

    expect(() => SkillLoader.discover(ws, emptyGlobalDir)).not.toThrow();
    const skills = SkillLoader.discover(ws, emptyGlobalDir);
    expect(skills[0].name).toBe("bad-yaml");
  });

  it("discovers multiple skills", () => {
    const ws = realpathSync(mkdtempSync(join(tempRoot, "test6-")));
    const skillsDir = makeWorkspace(ws);
    writeSkill(skillsDir, "skill-a", "---\nname: skill-a\ndescription: Alpha\n---");
    writeSkill(skillsDir, "skill-b", "---\nname: skill-b\ndescription: Beta\n---");
    writeSkill(skillsDir, "skill-c", "---\nname: skill-c\ndescription: Gamma\n---");

    const skills = SkillLoader.discover(ws, emptyGlobalDir);

    expect(skills).toHaveLength(3);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["skill-a", "skill-b", "skill-c"]);
  });

  it("discovers global skills from custom globalConfigDir", () => {
    const ws = realpathSync(mkdtempSync(join(tempRoot, "test7-ws-")));
    const globalDir = realpathSync(mkdtempSync(join(tempRoot, "test7-global-")));
    const globalSkillsDir = join(globalDir, "skills");
    mkdirSync(globalSkillsDir, { recursive: true });
    writeSkill(
      globalSkillsDir,
      "global-skill",
      "---\nname: global-skill\ndescription: From global\n---",
    );

    const skills = SkillLoader.discover(ws, globalDir);

    expect(skills.some((s) => s.name === "global-skill")).toBe(true);
    expect(skills.find((s) => s.name === "global-skill")?.description).toBe("From global");
  });

  it("project skills win over global on name conflict", () => {
    const ws = realpathSync(mkdtempSync(join(tempRoot, "test8-ws-")));
    const globalDir = realpathSync(mkdtempSync(join(tempRoot, "test8-global-")));
    const wsSkillsDir = makeWorkspace(ws);
    const globalSkillsDir = join(globalDir, "skills");
    mkdirSync(globalSkillsDir, { recursive: true });

    writeSkill(
      wsSkillsDir,
      "shared-name",
      "---\nname: shared-name\ndescription: Project version\n---",
    );
    writeSkill(
      globalSkillsDir,
      "shared-name",
      "---\nname: shared-name\ndescription: Global version\n---",
    );

    const skills = SkillLoader.discover(ws, globalDir);

    const match = skills.filter((s) => s.name === "shared-name");
    expect(match).toHaveLength(1);
    expect(match[0].description).toBe("Project version");
  });

  it("returns empty array when no skills dir exists", () => {
    const ws = realpathSync(mkdtempSync(join(tempRoot, "test9-")));
    const skills = SkillLoader.discover(ws, emptyGlobalDir);
    expect(skills).toEqual([]);
  });

  it("respects max 200 skills limit", () => {
    const ws = realpathSync(mkdtempSync(join(tempRoot, "test10-")));
    const skillsDir = makeWorkspace(ws);
    for (let i = 0; i < 250; i++) {
      writeSkill(
        skillsDir,
        `skill-${String(i).padStart(3, "0")}`,
        `---\nname: skill-${i}\ndescription: Desc ${i}\n---`,
      );
    }

    const skills = SkillLoader.discover(ws, emptyGlobalDir);

    expect(skills.length).toBeLessThanOrEqual(200);
  });
});

describe("SkillLoader.format", () => {
  it("returns empty string for empty array", () => {
    expect(SkillLoader.format([])).toBe("");
  });

  it("returns markdown list with skill name and description", () => {
    const skill: SkillMeta = {
      name: "my-skill",
      description: "Does something useful",
      path: "/some/path/SKILL.md",
    };

    const result = SkillLoader.format([skill]);

    expect(result).toContain("## Available Skills");
    expect(result).toContain("my-skill");
    expect(result).toContain("Does something useful");
  });

  it("includes all skills in output", () => {
    const skills: SkillMeta[] = [
      { name: "alpha", description: "Alpha skill", path: "/a/SKILL.md" },
      { name: "beta", description: "Beta skill", path: "/b/SKILL.md" },
    ];

    const result = SkillLoader.format(skills);

    expect(result).toContain("alpha");
    expect(result).toContain("beta");
    expect(result).toContain("Alpha skill");
    expect(result).toContain("Beta skill");
  });
});

describe("SkillLoader caching", () => {
  afterEach(() => {
    SkillLoader._resetCache();
  });

  it("discover returns cached result on repeated calls", () => {
    const ws = realpathSync(mkdtempSync(join(tempRoot, "cache1-")));
    const skillsDir = makeWorkspace(ws);
    writeSkill(skillsDir, "cached-skill", "---\nname: cached-skill\ndescription: Cached\n---");

    const first = SkillLoader.discover(ws, emptyGlobalDir);
    const second = SkillLoader.discover(ws, emptyGlobalDir);
    expect(second).toBe(first);
    expect(first).toHaveLength(1);
  });

  it("discover returns stale result after skill added until cache reset", () => {
    const ws = realpathSync(mkdtempSync(join(tempRoot, "cache2-")));
    const skillsDir = makeWorkspace(ws);
    writeSkill(skillsDir, "original", "---\nname: original\ndescription: First\n---");

    const first = SkillLoader.discover(ws, emptyGlobalDir);
    expect(first).toHaveLength(1);

    writeSkill(skillsDir, "added", "---\nname: added\ndescription: Second\n---");

    const cached = SkillLoader.discover(ws, emptyGlobalDir);
    expect(cached).toHaveLength(1);

    SkillLoader._resetCache();

    const fresh = SkillLoader.discover(ws, emptyGlobalDir);
    expect(fresh).toHaveLength(2);
  });
});

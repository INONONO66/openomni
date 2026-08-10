import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAssembler } from "../../src/context/middleware";

let tempRoot: string;

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "assembler-test-")));
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeWorkspace(name: string): string {
  const dir = join(tempRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkill(ws: string, dirName: string, name: string, description: string) {
  const skillDir = join(ws, ".openomni", "skills", dirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
}

describe("ContextAssembler.assemble", () => {
  it("returns empty string when workspace has no AGENTS.md and no skills", () => {
    const ws = makeWorkspace("empty");
    const result = ContextAssembler.assemble({ workspaceRoot: ws, globalConfigDir: ws });
    expect(result).toBe("");
  });

  it("returns instruction content when only AGENTS.md exists", () => {
    const ws = makeWorkspace("only-instructions");
    writeFileSync(join(ws, "AGENTS.md"), "# Project rules");

    const result = ContextAssembler.assemble({ workspaceRoot: ws, globalConfigDir: ws });
    expect(result).toContain("Instructions from");
    expect(result).toContain("# Project rules");
    expect(result).not.toContain("## Available Skills");
  });

  it("returns skills text when only skills exist", () => {
    const ws = makeWorkspace("only-skills");
    writeSkill(ws, "my-skill", "my-skill", "Does something useful");

    const result = ContextAssembler.assemble({ workspaceRoot: ws, globalConfigDir: ws });
    expect(result).toContain("## Available Skills");
    expect(result).toContain("my-skill");
    expect(result).not.toContain("Instructions from");
  });

  it("returns both sections when both instructions and skills exist", () => {
    const ws = makeWorkspace("both");
    writeFileSync(join(ws, "AGENTS.md"), "# Project rules");
    writeSkill(ws, "skill-alpha", "skill-alpha", "Alpha capability");

    const result = ContextAssembler.assemble({ workspaceRoot: ws, globalConfigDir: ws });
    expect(result).toContain("Instructions from");
    expect(result).toContain("# Project rules");
    expect(result).toContain("## Available Skills");
    expect(result).toContain("skill-alpha");
  });

  it("places instructions before skills when both present", () => {
    const ws = makeWorkspace("order");
    writeFileSync(join(ws, "AGENTS.md"), "# My instructions");
    writeSkill(ws, "order-skill", "order-skill", "Order test");

    const result = ContextAssembler.assemble({ workspaceRoot: ws, globalConfigDir: ws });
    const instructionsPos = result.indexOf("Instructions from");
    const skillsPos = result.indexOf("## Available Skills");
    expect(instructionsPos).toBeGreaterThanOrEqual(0);
    expect(skillsPos).toBeGreaterThanOrEqual(0);
    expect(instructionsPos).toBeLessThan(skillsPos);
  });

  it("separates instructions and skills with double newline", () => {
    const ws = makeWorkspace("separator");
    writeFileSync(join(ws, "AGENTS.md"), "# Separator test");
    writeSkill(ws, "sep-skill", "sep-skill", "Separator skill");

    const result = ContextAssembler.assemble({ workspaceRoot: ws, globalConfigDir: ws });
    expect(result).toContain("\n\n## Available Skills");
  });

  it("respects custom globalConfigDir for both instructions and skills", () => {
    const ws = makeWorkspace("custom-global-ws");
    const globalDir = makeWorkspace("custom-global-dir");

    writeFileSync(join(globalDir, "AGENTS.md"), "# Global instructions");
    const globalSkillsDir = join(globalDir, "skills", "global-skill");
    mkdirSync(globalSkillsDir, { recursive: true });
    writeFileSync(
      join(globalSkillsDir, "SKILL.md"),
      "---\nname: global-skill\ndescription: From global config\n---\n",
    );

    const result = ContextAssembler.assemble({ workspaceRoot: ws, globalConfigDir: globalDir });
    expect(result).toContain("Global instructions");
    expect(result).toContain("global-skill");
  });

  it("output contains 'Instructions from' header when instructions are present", () => {
    const ws = makeWorkspace("header-instructions");
    writeFileSync(join(ws, "AGENTS.md"), "Some content");

    const result = ContextAssembler.assemble({ workspaceRoot: ws, globalConfigDir: ws });
    expect(result).toContain("Instructions from");
  });

  it("output contains '## Available Skills' header when skills are present", () => {
    const ws = makeWorkspace("header-skills");
    writeSkill(ws, "hdr-skill", "hdr-skill", "Header skill test");

    const result = ContextAssembler.assemble({ workspaceRoot: ws, globalConfigDir: ws });
    expect(result).toContain("## Available Skills");
  });
});

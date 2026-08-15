import { describe, expect, test } from "bun:test";
import { ResidentAgent } from "../../src/agents";

function sectionFrom(prompt: string, heading: string): string {
  const start = prompt.indexOf(heading);
  if (start < 0) throw new Error(`missing prompt section: ${heading}`);
  const next = prompt.indexOf("\n## ", start + heading.length);
  return prompt.slice(start, next < 0 ? undefined : next);
}

describe("ResidentAgent prompt public surface", () => {
  test("keeps getPrompt public while helper members stay internal", async () => {
    const promptSource = await Bun.file(
      new URL("../../src/agents/resident/prompt/index.ts", import.meta.url),
    ).text();

    const gptPrompt = ResidentAgent.getPrompt({
      family: "gpt",
    });
    const inferredGptPrompt = ResidentAgent.getPrompt({
      model: { provider: "openai", id: "gpt-5" },
    });
    const claudePrompt = ResidentAgent.getPrompt({
      family: "claude",
    });
    const inferredClaudePrompt = ResidentAgent.getPrompt({
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    });

    expect(inferredGptPrompt).toBe(gptPrompt);
    expect(inferredClaudePrompt).toBe(claudePrompt);
    expect(gptPrompt).toContain("# OpenOmni Resident");
    expect(claudePrompt).toContain("# OpenOmni Resident");
    expect(gptPrompt).not.toBe(claudePrompt);
    expect(Object.getOwnPropertyNames(ResidentAgent).includes("getPrompt")).toBe(true);
    expect(Object.getOwnPropertyNames(ResidentAgent).includes("promptVariants")).toBe(false);
    expect(Object.getOwnPropertyNames(ResidentAgent).includes("buildPrompt")).toBe(false);
    expect(Object.getOwnPropertyNames(ResidentAgent).includes("inferPromptFamily")).toBe(false);
    expect(Object.getOwnPropertyNames(ResidentAgent).includes("getPromptVariant")).toBe(false);
    expect(promptSource).not.toMatch(/\bexport\s+const\s+promptVariants\b/);
    expect(promptSource).not.toMatch(/\bexport\s+const\s+buildPrompt\b/);
    expect(promptSource).not.toMatch(/\bexport\s+const\s+inferPromptFamily\b/);
    expect(promptSource).not.toMatch(/\bexport\s+function\s+getPromptVariant\b/);
  });

  test("instructs Resident to keep full tools while using direct tools first for cheap work", () => {
    for (const family of ["claude", "gpt"] as const) {
      const prompt = ResidentAgent.getPrompt({ family });
      const toolSection = sectionFrom(prompt, family === "claude" ? "## Tool Use" : "## Tools");
      const delegationSection = sectionFrom(prompt, "## Delegation");

      for (const category of ["filesystem", "execution", "delegation", "mcp", "custom"] as const) {
        expect(toolSection.toLowerCase()).toContain(category);
      }
      expect(toolSection.toLowerCase()).toContain("full tool");
      expect(toolSection.toLowerCase()).toContain("direct tools");
      expect(toolSection.toLowerCase()).toContain("small cheap");
      expect(delegationSection.toLowerCase()).toContain("substantial independent work");
    }
  });
});

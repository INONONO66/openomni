import { describe, expect, test } from "bun:test";
import { ResidentAgent } from "../../src/agents";

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
    expect(Object.hasOwn(ResidentAgent, "getPrompt")).toBe(true);
    expect(Object.hasOwn(ResidentAgent, "promptVariants")).toBe(false);
    expect(Object.hasOwn(ResidentAgent, "buildPrompt")).toBe(false);
    expect(Object.hasOwn(ResidentAgent, "inferPromptFamily")).toBe(false);
    expect(Object.hasOwn(ResidentAgent, "getPromptVariant")).toBe(false);
    expect(promptSource).not.toMatch(/\bexport\s+const\s+promptVariants\b/);
    expect(promptSource).not.toMatch(/\bexport\s+const\s+buildPrompt\b/);
    expect(promptSource).not.toMatch(/\bexport\s+const\s+inferPromptFamily\b/);
    expect(promptSource).not.toMatch(/\bexport\s+function\s+getPromptVariant\b/);
  });
});

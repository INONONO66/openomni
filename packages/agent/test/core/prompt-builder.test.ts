import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../../src/core/prompt-builder";

describe("buildSystemPrompt", () => {
  it("combines base prompt with tool prompt", () => {
    const result = buildSystemPrompt("base", [{ name: "bash", prompt: "rules" }]);
    expect(result).toBe("base\n\n---\n\n## Tool: bash\nrules");
  });

  it("returns base prompt when no tool has prompt", () => {
    const result = buildSystemPrompt("base", [{ name: "bash" }]);
    expect(result).toBe("base");
  });

  it("returns tool prompt when no base prompt", () => {
    const result = buildSystemPrompt(undefined, [{ name: "bash", prompt: "rules" }]);
    expect(result).toBe("## Tool: bash\nrules");
  });

  it("returns undefined when no base and no tool prompts", () => {
    const result = buildSystemPrompt(undefined, []);
    expect(result).toBeUndefined();
  });
});

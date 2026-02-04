import { describe, it, expect } from "bun:test";
import { Agent } from "../../src/agent";

describe("Agent", () => {
  describe("Schema", () => {
    it("should validate agent with required name only", () => {
      const agent = {
        name: "test-agent",
      };
      const result = Agent.Info.safeParse(agent);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("test-agent");
        expect(result.data.description).toBeUndefined();
        expect(result.data.systemPrompt).toBeUndefined();
        expect(result.data.temperature).toBeUndefined();
      }
    });

    it("should validate agent with all optional fields", () => {
      const agent = {
        name: "custom-agent",
        description: "A custom agent for testing",
        systemPrompt: "You are a helpful assistant.",
        temperature: 0.7,
      };
      const result = Agent.Info.safeParse(agent);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("custom-agent");
        expect(result.data.description).toBe("A custom agent for testing");
        expect(result.data.systemPrompt).toBe("You are a helpful assistant.");
        expect(result.data.temperature).toBe(0.7);
      }
    });

    it("should reject agent without name", () => {
      const agent = {
        description: "Missing name",
      };
      const result = Agent.Info.safeParse(agent);
      expect(result.success).toBe(false);
    });

    it("should reject invalid temperature (negative)", () => {
      const agent = {
        name: "test",
        temperature: -0.5,
      };
      const result = Agent.Info.safeParse(agent);
      expect(result.success).toBe(false);
    });

    it("should reject invalid temperature (over 2)", () => {
      const agent = {
        name: "test",
        temperature: 2.5,
      };
      const result = Agent.Info.safeParse(agent);
      expect(result.success).toBe(false);
    });
  });

  describe("Default Agent", () => {
    it("should provide default assistant agent", () => {
      const assistant = Agent.defaults.assistant;
      expect(assistant).toBeDefined();
      expect(assistant.name).toBe("assistant");
      expect(assistant.description).toBeDefined();
      expect(assistant.systemPrompt).toBeDefined();
    });

    it("assistant should have valid schema", () => {
      const result = Agent.Info.safeParse(Agent.defaults.assistant);
      expect(result.success).toBe(true);
    });

    it("assistant should have reasonable system prompt", () => {
      const assistant = Agent.defaults.assistant;
      expect(assistant.systemPrompt).toContain("assistant");
    });
  });
});

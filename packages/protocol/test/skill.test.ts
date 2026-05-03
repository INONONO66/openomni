import { describe, expect, test } from "bun:test";
import { Skill } from "../src/index.js";

const it = test;

describe("Skill protocol domain", () => {
  describe("Skill.Definition", () => {
    it("parses a local execution skill definition", () => {
      const def = {
        id: "skill-local-exec",
        name: "Local Executor",
        description: "Executes tasks locally",
        scope: "local" as const,
        layer: "execution" as const,
        path: ".openomni/skills/local-exec/SKILL.md",
      };

      const result = Skill.Definition.safeParse(def);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("skill-local-exec");
        expect(result.data.scope).toBe("local");
        expect(result.data.layer).toBe("execution");
      }
    });

    it("parses a global guarantee skill definition", () => {
      const def = {
        id: "skill-global-guarantee",
        name: "Global Guarantee",
        description: "Provides global guarantees",
        scope: "global" as const,
        layer: "guarantee" as const,
        path: "~/.openomni/skills/guarantee/SKILL.md",
        useWhen: "Always available",
        doNotUseWhen: "Never",
        finalChecklist: ["Check 1", "Check 2"],
      };

      const result = Skill.Definition.safeParse(def);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scope).toBe("global");
        expect(result.data.layer).toBe("guarantee");
        expect(result.data.useWhen).toBe("Always available");
        expect(result.data.finalChecklist).toEqual(["Check 1", "Check 2"]);
      }
    });

    it("parses a global enhancement skill definition", () => {
      const def = {
        id: "skill-global-enhance",
        name: "Global Enhancement",
        description: "Enhances capabilities",
        scope: "global" as const,
        layer: "enhancement" as const,
        path: "~/.openomni/skills/enhance/SKILL.md",
      };

      const result = Skill.Definition.safeParse(def);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.layer).toBe("enhancement");
      }
    });

    it("rejects invalid layer", () => {
      const def = {
        id: "skill-invalid",
        name: "Invalid",
        description: "Invalid skill",
        scope: "local" as const,
        layer: "invalid" as unknown,
        path: "/path/to/skill",
      };

      const result = Skill.Definition.safeParse(def);
      expect(result.success).toBe(false);
    });

    it("rejects invalid scope", () => {
      const def = {
        id: "skill-invalid",
        name: "Invalid",
        description: "Invalid skill",
        scope: "invalid" as unknown,
        layer: "execution" as const,
        path: "/path/to/skill",
      };

      const result = Skill.Definition.safeParse(def);
      expect(result.success).toBe(false);
    });

    it("requires id, name, description, scope, layer, and path", () => {
      const incomplete = {
        id: "skill-incomplete",
        name: "Incomplete",
      };

      const result = Skill.Definition.safeParse(incomplete);
      expect(result.success).toBe(false);
    });
  });

  describe("Skill.RegistryEntry", () => {
    it("parses an enabled registry entry", () => {
      const entry = {
        id: "skill-local-exec",
        version: "1.0.0",
        installedAt: 1714809600000,
        enabled: true,
      };

      const result = Skill.RegistryEntry.safeParse(entry);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(true);
        expect(result.data.version).toBe("1.0.0");
      }
    });

    it("parses a disabled registry entry", () => {
      const entry = {
        id: "skill-global-enhance",
        version: "2.1.0",
        installedAt: 1714809600000,
        source: "https://github.com/example/skill",
        enabled: false,
      };

      const result = Skill.RegistryEntry.safeParse(entry);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(false);
        expect(result.data.source).toBe("https://github.com/example/skill");
      }
    });

    it("requires id, version, installedAt, and enabled", () => {
      const incomplete = {
        id: "skill-incomplete",
        version: "1.0.0",
      };

      const result = Skill.RegistryEntry.safeParse(incomplete);
      expect(result.success).toBe(false);
    });

    it("allows optional source field", () => {
      const entry = {
        id: "skill-no-source",
        version: "1.0.0",
        installedAt: 1714809600000,
        enabled: true,
      };

      const result = Skill.RegistryEntry.safeParse(entry);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.source).toBeUndefined();
      }
    });
  });

  describe("Skill.Layer enum", () => {
    it("accepts all three layer values", () => {
      expect(Skill.Layer.safeParse("guarantee").success).toBe(true);
      expect(Skill.Layer.safeParse("enhancement").success).toBe(true);
      expect(Skill.Layer.safeParse("execution").success).toBe(true);
    });

    it("rejects invalid layer values", () => {
      expect(Skill.Layer.safeParse("invalid").success).toBe(false);
      expect(Skill.Layer.safeParse("").success).toBe(false);
      expect(Skill.Layer.safeParse(null).success).toBe(false);
    });
  });

  describe("Skill.Scope enum", () => {
    it("accepts both scope values", () => {
      expect(Skill.Scope.safeParse("local").success).toBe(true);
      expect(Skill.Scope.safeParse("global").success).toBe(true);
    });

    it("rejects invalid scope values", () => {
      expect(Skill.Scope.safeParse("invalid").success).toBe(false);
      expect(Skill.Scope.safeParse("").success).toBe(false);
      expect(Skill.Scope.safeParse(null).success).toBe(false);
    });
  });
});

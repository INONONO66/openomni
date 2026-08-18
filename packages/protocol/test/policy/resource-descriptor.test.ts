import { describe, expect, test } from "bun:test";
import { Policy } from "../../src/policy/index.js";

describe("Policy.Resource descriptors", () => {
  describe("Descriptor", () => {
    test("parses a two-segment descriptor id", () => {
      const result = Policy.Resource.Descriptor.parse({
        id: "tool:bash",
        kind: "tool",
        labels: ["source:system"],
        capabilities: ["shell.exec"],
        effects: ["workspace.mutate"],
      });

      expect(result.id).toBe("tool:bash");
      expect(result.kind).toBe("tool");
      expect(result.source).toBe(undefined);
    });

    test("parses a three-segment descriptor id with source metadata", () => {
      const result = Policy.Resource.Descriptor.parse({
        id: "skill:project:git-master",
        kind: "skill",
        labels: ["source:project"],
        capabilities: ["behavior.inject"],
        effects: ["prompt.modify"],
        source: {
          type: "project",
        },
        digest: "sha256:abc123",
      });

      expect(result.id).toBe("skill:project:git-master");
      expect(result.kind).toBe("skill");
      expect(result.source?.type).toBe("project");
      expect(result.digest).toBe("sha256:abc123");
    });

    test("rejects a custom kind string", () => {
      expect(
        Policy.Resource.Descriptor.safeParse({
          id: "custom:thing",
          kind: "custom-resource-type",
          labels: [],
          capabilities: [],
          effects: [],
        }).success,
      ).toBe(false);
    });

    test("rejects mismatched id segments", () => {
      expect(
        Policy.Resource.Descriptor.safeParse({
          id: "tool:project",
          kind: "tool",
          labels: [],
          capabilities: [],
          effects: [],
          source: { type: "project" },
        }).success,
      ).toBe(false);
    });

    test("rejects descriptors with invalid source type", () => {
      expect(
        Policy.Resource.Descriptor.safeParse({
          id: "tool:server:bash",
          kind: "tool",
          labels: [],
          capabilities: [],
          effects: [],
          source: { type: "http" },
        }).success,
      ).toBe(false);
    });
  });
});

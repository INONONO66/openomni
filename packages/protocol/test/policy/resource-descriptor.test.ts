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

    test("enforces id arity, non-empty segments, and the kind prefix independently", () => {
      const descriptor = {
        labels: [],
        capabilities: [],
        effects: [],
      };

      expect(
        Policy.Resource.Descriptor.safeParse({
          ...descriptor,
          id: "worker:one:two:three",
          kind: "worker",
        }).success,
      ).toBe(false);
      expect(
        Policy.Resource.Descriptor.safeParse({
          ...descriptor,
          id: "worker:",
          kind: "worker",
        }).success,
      ).toBe(false);
      expect(
        Policy.Resource.Descriptor.safeParse({
          ...descriptor,
          id: "session:primary",
          kind: "worker",
        }).success,
      ).toBe(false);
    });

    test("binds tool source presence and type to the corresponding id segments", () => {
      const descriptor = {
        kind: "tool" as const,
        labels: [],
        capabilities: [],
        effects: [],
      };

      expect(
        Policy.Resource.Descriptor.safeParse({
          ...descriptor,
          id: "tool:project:bash",
        }).success,
      ).toBe(false);
      expect(
        Policy.Resource.Descriptor.safeParse({
          ...descriptor,
          id: "tool:bash",
          source: { type: "project" },
        }).success,
      ).toBe(false);
      expect(
        Policy.Resource.Descriptor.safeParse({
          ...descriptor,
          id: "tool:server:bash",
          source: { type: "project" },
        }).success,
      ).toBe(false);

      const parsed = Policy.Resource.Descriptor.parse({
        ...descriptor,
        id: "tool:skill-mcp:filesystem:read_file",
        source: { type: "skill-mcp", serverId: "filesystem" },
      });
      expect(parsed.id).toBe("tool:skill-mcp:filesystem:read_file");
      expect(parsed.source).toEqual({ type: "skill-mcp", serverId: "filesystem" });
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

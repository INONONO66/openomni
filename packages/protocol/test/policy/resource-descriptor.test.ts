import { describe, expect, test } from "bun:test";
import { RuntimeResource } from "../../src/policy/index.js";

describe("RuntimeResource descriptors", () => {
  describe("Descriptor", () => {
    test("parses a two-segment descriptor id", () => {
      const result = RuntimeResource.Descriptor.parse({
        id: "tool:bash",
        kind: "tool",
        labels: ["source.system"],
        capabilities: ["shell.exec"],
        effects: ["workspace.mutate"],
      });

      expect(result.id).toBe("tool:bash");
      expect(result.kind).toBe("tool");
      expect(result.source).toBe(undefined);
    });

    test("parses a three-segment descriptor id with source metadata", () => {
      const result = RuntimeResource.Descriptor.parse({
        id: "skill:project:git-master",
        kind: "skill",
        labels: ["source.project"],
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
        RuntimeResource.Descriptor.safeParse({
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
        RuntimeResource.Descriptor.safeParse({
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
        RuntimeResource.Descriptor.safeParse({
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

  describe("ActorDescriptor", () => {
    test("parses a user actor descriptor", () => {
      const result = RuntimeResource.ActorDescriptor.parse({
        actorId: "user:ino",
        actorType: "user",
        permissions: ["inbound.submit"],
        labels: ["trust.owner"],
      });

      expect(result.actorId).toBe("user:ino");
      expect(result.actorType).toBe("user");
      expect(result.permissions).toEqual(["inbound.submit"]);
    });

    test("parses an agent actor descriptor with profile reference", () => {
      const result = RuntimeResource.ActorDescriptor.parse({
        actorId: "agent:main-persona",
        actorType: "agent",
        agentProfileRef: "agent-profile:main-persona",
        permissions: ["tool.exec", "inbound.submit"],
      });

      expect(result.actorType).toBe("agent");
      expect(result.agentProfileRef).toBe("agent-profile:main-persona");
    });

    test("rejects invalid actor type", () => {
      expect(
        RuntimeResource.ActorDescriptor.safeParse({
          actorId: "actor:bad",
          actorType: "worker",
          permissions: [],
        }).success,
      ).toBe(false);
    });
  });

  describe("SessionDescriptor", () => {
    test("parses a root session descriptor", () => {
      const result = RuntimeResource.SessionDescriptor.parse({
        sessionId: "session:root-1",
        sessionType: "root",
        ownerActorId: "user:ino",
      });

      expect(result.sessionId).toBe("session:root-1");
      expect(result.sessionType).toBe("root");
      expect(result.parentSessionId).toBe(undefined);
    });

    test("parses a self-loop session descriptor", () => {
      const result = RuntimeResource.SessionDescriptor.parse({
        sessionId: "session:self-loop-1",
        parentSessionId: "session:root-1",
        sessionType: "self-loop",
        ownerActorId: "agent:main-persona",
      });

      expect(result.sessionType).toBe("self-loop");
      expect(result.parentSessionId).toBe("session:root-1");
    });

    test("rejects invalid session type", () => {
      expect(
        RuntimeResource.SessionDescriptor.safeParse({
          sessionId: "session:bad",
          sessionType: "child-loop",
          ownerActorId: "user:ino",
        }).success,
      ).toBe(false);
    });
  });
});

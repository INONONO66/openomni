import { describe, it, expect, beforeEach } from "bun:test";
import { SurfaceKey, Storage, Session } from "@openomni/session";
import { IngressSessionResolver } from "../../src/ingress/session-resolver";

describe("IngressSessionResolver", () => {
  beforeEach(() => {
    SurfaceKey.clear();
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  describe("extractSurfaceKey", () => {
    it("builds key from surface + workspace + channel", () => {
      const event = {
        surface: "slack",
        workspace: "team-a",
        channel: "C123",
      };
      const key = IngressSessionResolver.extractSurfaceKey(event);
      expect(key).toBe("slack:team-a:C123");
    });

    it("builds key from surface + workspace (no channel)", () => {
      const event = {
        surface: "tui",
        workspace: "/Users/ino/Develop/OpenOmni",
      };
      const key = IngressSessionResolver.extractSurfaceKey(event);
      expect(key).toBe("tui:/Users/ino/Develop/OpenOmni:");
    });

    it("builds key from surface only", () => {
      const event = {
        surface: "tui",
      };
      const key = IngressSessionResolver.extractSurfaceKey(event);
      expect(key).toBe("tui::");
    });

    it("filters out undefined and empty string parts", () => {
      const event = {
        surface: "slack",
        workspace: "",
        channel: "C123",
      };
      const key = IngressSessionResolver.extractSurfaceKey(event);
      expect(key).toBe("slack::C123");
    });

    it("handles all undefined optional fields", () => {
      const event = {
        surface: "telegram",
        workspace: undefined,
        channel: undefined,
      };
      const key = IngressSessionResolver.extractSurfaceKey(event);
      expect(key).toBe("telegram::");
    });

    it("appends explicit ADR-008 target to avoid session collisions", () => {
      const key = IngressSessionResolver.extractSurfaceKey({
        surface: "internal",
        workspace: "repo",
        channel: "resident",
        target: { kind: "worker", workerId: "worker-1" },
      });

      expect(key).toBe("internal:repo:resident:target:worker:worker-1");
    });

    it("does not append explicit resident target to preserve existing surface mappings", () => {
      const key = IngressSessionResolver.extractSurfaceKey({
        surface: "telegram",
        channel: "123",
        target: { kind: "resident" },
      });

      expect(key).toBe("telegram::123");
    });
  });

  describe("resolve", () => {
    it("creates worker sessions as children when parent session is supplied", () => {
      const parent = Session.create({
        title: "parent",
        model: { providerID: "test", modelID: "fixture" },
      });

      const result = IngressSessionResolver.resolve({
        surface: "resident-worker-tool",
        target: { kind: "worker", parentSessionId: parent.id },
      });

      expect(result.session.parentSessionId).toBe(parent.id);
      expect(result.session.spawnDepth).toBe(parent.spawnDepth + 1);
      expect(Session.listChildren(parent.id).map((session) => session.id)).toContain(
        result.session.id,
      );
    });

    it("creates new session for new surface key", () => {
      const event = {
        surface: "slack",
        workspace: "team-a",
        channel: "C123",
      };
      const result = IngressSessionResolver.resolve(event);

      expect(result.isNew).toBe(true);
      expect(result.session.id).toBeDefined();
      expect(result.session.title).toBe("Session from slack");
      expect(result.session.model.providerID).toBe("anthropic");
      expect(result.session.model.modelID).toBe("claude-3-5-sonnet-20241022");
    });

    it("reuses same session for same surface key on second call", () => {
      const event = {
        surface: "slack",
        workspace: "team-a",
        channel: "C123",
      };

      const result1 = IngressSessionResolver.resolve(event);
      const result2 = IngressSessionResolver.resolve(event);

      expect(result1.isNew).toBe(true);
      expect(result2.isNew).toBe(false);
      expect(result1.session.id).toBe(result2.session.id);
    });

    it("creates different sessions for different surface keys", () => {
      const event1 = {
        surface: "slack",
        workspace: "team-a",
        channel: "C123",
      };
      const event2 = {
        surface: "slack",
        workspace: "team-b",
        channel: "C456",
      };

      const result1 = IngressSessionResolver.resolve(event1);
      const result2 = IngressSessionResolver.resolve(event2);

      expect(result1.session.id).not.toBe(result2.session.id);
      expect(result1.isNew).toBe(true);
      expect(result2.isNew).toBe(true);
    });

    it("creates new session if existing session was deleted (stale key)", () => {
      const event = {
        surface: "tui",
        workspace: "/project",
      };

      // First resolve: creates new session
      const result1 = IngressSessionResolver.resolve(event);
      const sessionId1 = result1.session.id;
      expect(result1.isNew).toBe(true);

      // Delete the session
      Session.remove(sessionId1);
      // Second resolve: should create new session (stale key)
      const result2 = IngressSessionResolver.resolve(event);
      const sessionId2 = result2.session.id;

      expect(result2.isNew).toBe(true);
      expect(sessionId1).not.toBe(sessionId2);
    });

    it("fails closed when worker target session is missing", () => {
      expect(() =>
        IngressSessionResolver.resolve({
          surface: "internal",
          target: { kind: "worker", sessionId: "missing-session" },
        }),
      ).toThrow("worker target session not found");
    });

    it("uses custom model config when provided", () => {
      const event = {
        surface: "telegram",
        workspace: "bot-123",
      };
      const customModel = {
        providerID: "openai",
        modelID: "gpt-4",
      };

      const result = IngressSessionResolver.resolve(event, customModel);

      expect(result.session.model.providerID).toBe("openai");
      expect(result.session.model.modelID).toBe("gpt-4");
    });
  });
});

import { describe, it, expect, beforeEach } from "bun:test";
import { SurfaceKey, Storage, Session } from "@openomni/session";
import { IngressSessionResolver } from "../../src/ingress";

/** resolve() with the test trace context; model stays on the resolver default unless given. */
function resolveWithTrace(
  event: Parameters<typeof IngressSessionResolver.resolve>[0],
  model?: Parameters<typeof IngressSessionResolver.resolve>[2],
) {
  return IngressSessionResolver.resolve(event, { traceId: "trace-resolver-test" }, model);
}

describe("IngressSessionResolver", () => {
  beforeEach(() => {
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
        traceId: "trace-resolver-test",
        title: "parent",
        model: { providerID: "test", modelID: "fixture" },
      });

      const result = resolveWithTrace({
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
      const result = resolveWithTrace(event);

      expect(result.isNew).toBe(true);
      expect(result.session.id).toBeDefined();
      expect(result.session.title).toBe("Session from slack");
      expect(result.session.model.providerID).toBe("anthropic");
      expect(result.session.model.modelID).toBe("claude-sonnet-4-5");
    });

    it("reuses same session for same surface key on second call", () => {
      const event = {
        surface: "slack",
        workspace: "team-a",
        channel: "C123",
      };

      const result1 = resolveWithTrace(event);
      const result2 = resolveWithTrace(event);

      expect(result1.isNew).toBe(true);
      expect(result2.isNew).toBe(false);
      expect(result1.session.id).toBe(result2.session.id);
    });

    it("returns a concurrent surface key owner instead of clobbering it", () => {
      const event = {
        surface: "slack",
        workspace: "team-a",
        channel: "C123",
      };
      const key = IngressSessionResolver.extractSurfaceKey(event);
      const competing = Session.create({
        traceId: "trace-resolver-test",
        title: "competing",
        model: { providerID: "test", modelID: "fixture" },
      });

      const surfaceKey = Storage.get().surfaceKey;
      if (!surfaceKey?.claim) throw new Error("surfaceKey claim adapter missing");
      const originalClaim = surfaceKey.claim.bind(surfaceKey);
      surfaceKey.claim = (claimKey, _candidateSessionId, expectedSessionId) => {
        expect(claimKey).toBe(key);
        return originalClaim(claimKey, competing.id, expectedSessionId);
      };

      try {
        const result = resolveWithTrace(event);

        expect(result.isNew).toBe(false);
        expect(result.session.id).toBe(competing.id);
        expect(SurfaceKey.lookup(key)).toBe(competing.id);
        expect(Session.list().map((session) => session.id)).toEqual([competing.id]);
      } finally {
        surfaceKey.claim = originalClaim;
      }
    });

    it("removes the candidate session if claiming the surface key fails", () => {
      const event = {
        surface: "slack",
        workspace: "team-a",
        channel: "C123",
      };
      const surfaceKey = Storage.get().surfaceKey;
      if (!surfaceKey?.claim) throw new Error("surfaceKey claim adapter missing");
      const originalClaim = surfaceKey.claim.bind(surfaceKey);
      surfaceKey.claim = () => {
        throw new Error("claim failed");
      };

      try {
        expect(() => resolveWithTrace(event)).toThrow("claim failed");
        expect(Session.list()).toEqual([]);
      } finally {
        surfaceKey.claim = originalClaim;
      }
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

      const result1 = resolveWithTrace(event1);
      const result2 = resolveWithTrace(event2);

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
      const result1 = resolveWithTrace(event);
      const sessionId1 = result1.session.id;
      expect(result1.isNew).toBe(true);

      // Delete the session
      Session.remove(sessionId1, "trace-resolver-test");
      // Second resolve: should create new session (stale key)
      const result2 = resolveWithTrace(event);
      const sessionId2 = result2.session.id;

      expect(result2.isNew).toBe(true);
      expect(sessionId1).not.toBe(sessionId2);
    });

    it("fails closed when worker target session is missing", () => {
      expect(() =>
        resolveWithTrace({
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

      const result = resolveWithTrace(event, customModel);

      expect(result.session.model.providerID).toBe("openai");
      expect(result.session.model.modelID).toBe("gpt-4");
    });
  });
});

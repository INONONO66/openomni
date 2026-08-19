import { describe, it, expect, beforeEach } from "bun:test";
import { Ingress, extractSurfaceKey } from "@openomni/protocol";
import { SurfaceKey, Storage, Session } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
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
    Bus.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  describe("extractSurfaceKey", () => {
    it("builds key from surface + workspace + channel", () => {
      const event = {
        surface: "slack",
        workspace: "team-a",
        channel: "C123",
      };
      const key = extractSurfaceKey(event);
      expect(key).toBe("slack:team-a:C123");
    });

    it("builds key from surface + workspace (no channel)", () => {
      const event = {
        surface: "tui",
        workspace: "/Users/ino/Develop/OpenOmni",
      };
      const key = extractSurfaceKey(event);
      expect(key).toBe("tui:/Users/ino/Develop/OpenOmni:");
    });

    it("builds key from surface only", () => {
      const event = {
        surface: "tui",
      };
      const key = extractSurfaceKey(event);
      expect(key).toBe("tui::");
    });

    it("filters out undefined and empty string parts", () => {
      const event = {
        surface: "slack",
        workspace: "",
        channel: "C123",
      };
      const key = extractSurfaceKey(event);
      expect(key).toBe("slack::C123");
    });

    it("handles all undefined optional fields", () => {
      const event = {
        surface: "telegram",
        workspace: undefined,
        channel: undefined,
      };
      const key = extractSurfaceKey(event);
      expect(key).toBe("telegram::");
    });

    it("appends explicit ADR-008 target to avoid session collisions", () => {
      const key = extractSurfaceKey({
        surface: "internal",
        workspace: "repo",
        channel: "resident",
        target: { kind: "worker", workerId: "worker-1" },
      });

      expect(key).toBe("internal:repo:resident:target:worker:worker-1");
    });

    it("does not append explicit resident target to preserve existing surface mappings", () => {
      const key = extractSurfaceKey({
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

    it("returns a concurrent surface key owner instead of clobbering it", async () => {
      const event = {
        surface: "slack",
        workspace: "team-a",
        channel: "C123",
      };
      const key = extractSurfaceKey(event);
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

      const deleted: Array<{ traceId: string; id: string }> = [];
      const unsub = Bus.subscribe(Session.Event.Deleted, (data) => {
        deleted.push(data);
      });
      try {
        const result = resolveWithTrace(event);

        expect(result.isNew).toBe(false);
        expect(result.session.id).toBe(competing.id);
        expect(SurfaceKey.lookup(key)).toBe(competing.id);
        expect(Session.list().map((session) => session.id)).toEqual([competing.id]);
        // Pin (D11): the losing candidate's removal files under the inbound
        // frame's trace — a wrong-but-nonempty id here would typecheck.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(deleted).toEqual([
          { traceId: "trace-resolver-test", id: expect.not.stringMatching(competing.id) },
        ]);
      } finally {
        unsub();
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

  // #707 stage 2: the gateway router mints + claims the resident session
  // LABEL; the brain owns the ROW and materializes it lazily on first
  // Deliver, idempotently.
  describe("materializeResident", () => {
    const trace = { traceId: "trace-resolver-test" };

    it("creates the session row when absent", () => {
      const sessionId = crypto.randomUUID();

      const result = IngressSessionResolver.materializeResident(
        { surface: "slack" },
        sessionId,
        trace,
      );

      expect(result.isNew).toBe(true);
      expect(result.session.id).toBe(sessionId);
      expect(result.session.title).toBe("Session from slack");
      expect(Session.get(sessionId)?.id).toBe(sessionId);
    });

    it("returns the existing row when present", () => {
      const sessionId = crypto.randomUUID();

      const first = IngressSessionResolver.materializeResident(
        { surface: "slack" },
        sessionId,
        trace,
      );
      const second = IngressSessionResolver.materializeResident(
        { surface: "slack" },
        sessionId,
        trace,
      );

      expect(first.isNew).toBe(true);
      expect(second.isNew).toBe(false);
      expect(second.session.id).toBe(sessionId);
      expect(Session.list().map((session) => session.id)).toEqual([sessionId]);
    });

    it("publishes ingress.session.resolved with materialization freshness", async () => {
      const sessionId = crypto.randomUUID();
      const resolved: Array<{ sessionId: string; isNew: boolean; target?: string }> = [];
      const unsubscribe = Bus.subscribe(Ingress.Events.SessionResolved, (event) => {
        resolved.push(event);
      });

      try {
        IngressSessionResolver.materializeResident({ surface: "slack" }, sessionId, trace);
        IngressSessionResolver.materializeResident({ surface: "slack" }, sessionId, trace);
        // Bus delivery is queued off the synchronous call path.
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        unsubscribe();
      }

      expect(
        resolved.map((entry) => ({
          sessionId: entry.sessionId,
          isNew: entry.isNew,
          target: entry.target,
        })),
      ).toEqual([
        { sessionId, isNew: true, target: "resident" },
        { sessionId, isNew: false, target: "resident" },
      ]);
    });
  });
});

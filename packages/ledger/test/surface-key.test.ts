import { describe, test, expect, beforeEach } from "bun:test";
import { Channel } from "@openomni/protocol";
import { SurfaceKey } from "../src/surface-key";
import { Storage } from "../src/storage/storage";
import "../src/storage/initialize";

// The pure string codec (create/fromChannel/parse) lives in the protocol
// adapter domain — see packages/protocol/test/adapter-surface-key.test.ts.
// This suite covers the storage semantics: claim/lookup/listBySession.

function seedSession(id: string): void {
  Storage.get().session.set(id, {
    id,
    title: "test",
    model: { providerID: "test", modelID: "test" },
    time: { created: Date.now(), updated: Date.now() },
    spawnDepth: 0,
  });
}

describe("SurfaceKey", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  describe("claim and lookup", () => {
    test("claims and looks up a surfaceKey", () => {
      const key = "slack:workspaceA:channel:C123";
      const sessionId = "session-123";

      seedSession(sessionId);
      SurfaceKey.claim(key, sessionId);
      expect(SurfaceKey.lookup(key)).toBe(sessionId);
    });

    test("returns undefined for unregistered key", () => {
      expect(SurfaceKey.lookup("slack:unknown")).toBeUndefined();
    });

    test("throws error on invalid format during claim", () => {
      expect(() => SurfaceKey.claim("invalid", "session-123")).toThrow(/Invalid surfaceKey format/);
    });

    test("claim with the current owner as expected reassigns the key", () => {
      const key = "slack:workspaceA:channel:C123";
      const sessionId1 = "session-1";
      const sessionId2 = "session-2";

      seedSession(sessionId1);
      seedSession(sessionId2);
      SurfaceKey.claim(key, sessionId1);
      expect(SurfaceKey.lookup(key)).toBe(sessionId1);

      SurfaceKey.claim(key, sessionId2, sessionId1);
      expect(SurfaceKey.lookup(key)).toBe(sessionId2);
    });
  });

  describe("N:1 mapping (multiple keys → same session)", () => {
    test("allows multiple keys to map to same session", () => {
      const sessionId = "session-123";
      const key1 = "slack:workspaceA:channel:C123";
      const key2 = "slack:workspaceA:channel:C456";

      seedSession(sessionId);
      SurfaceKey.claim(key1, sessionId);
      SurfaceKey.claim(key2, sessionId);

      expect(SurfaceKey.lookup(key1)).toBe(sessionId);
      expect(SurfaceKey.lookup(key2)).toBe(sessionId);
    });

    test("lists all keys for a session", () => {
      const sessionId = "session-123";
      const key1 = "slack:workspaceA:channel:C123";
      const key2 = "slack:workspaceA:channel:C456";
      const key3 = "telegram:botId:chat:chatId";

      seedSession(sessionId);
      SurfaceKey.claim(key1, sessionId);
      SurfaceKey.claim(key2, sessionId);
      SurfaceKey.claim(key3, sessionId);

      const keys = SurfaceKey.listBySession(sessionId);
      expect(keys).toHaveLength(3);
      expect(keys).toContain(key1);
      expect(keys).toContain(key2);
      expect(keys).toContain(key3);
    });

    test("returns empty array for session with no keys", () => {
      expect(SurfaceKey.listBySession("unknown-session")).toEqual([]);
    });
  });

  describe("collision handling", () => {
    test("handles key reassignment from one session to another", () => {
      const key = "slack:workspaceA:channel:C123";
      const sessionId1 = "session-1";
      const sessionId2 = "session-2";

      seedSession(sessionId1);
      seedSession(sessionId2);
      SurfaceKey.claim(key, sessionId1);
      expect(SurfaceKey.lookup(key)).toBe(sessionId1);
      expect(SurfaceKey.listBySession(sessionId1)).toContain(key);

      SurfaceKey.claim(key, sessionId2, sessionId1);
      expect(SurfaceKey.lookup(key)).toBe(sessionId2);
      expect(SurfaceKey.listBySession(sessionId1)).not.toContain(key);
      expect(SurfaceKey.listBySession(sessionId2)).toContain(key);
    });

    test("claim returns existing owner without overwriting it", () => {
      const key = "slack:workspaceA:channel:C123";
      seedSession("session-1");
      seedSession("session-2");
      SurfaceKey.claim(key, "session-1");

      const owner = SurfaceKey.claim(key, "session-2");

      expect(owner).toBe("session-1");
      expect(SurfaceKey.lookup(key)).toBe("session-1");
    });

    test("claim can replace an expected owner", () => {
      const key = "slack:workspaceA:channel:C123";
      seedSession("session-1");
      seedSession("session-2");
      SurfaceKey.claim(key, "session-1");

      const owner = SurfaceKey.claim(key, "session-2", "session-1");

      expect(owner).toBe("session-2");
      expect(SurfaceKey.lookup(key)).toBe("session-2");
    });

    test("maintains bidirectional consistency", () => {
      const sessionId = "session-123";
      const key1 = "slack:workspaceA:channel:C123";
      const key2 = "slack:workspaceA:channel:C456";

      seedSession(sessionId);
      SurfaceKey.claim(key1, sessionId);
      SurfaceKey.claim(key2, sessionId);

      expect(SurfaceKey.lookup(key1)).toBe(sessionId);
      expect(SurfaceKey.lookup(key2)).toBe(sessionId);

      const keys = SurfaceKey.listBySession(sessionId);
      expect(keys).toHaveLength(2);
      expect(keys).toContain(key1);
      expect(keys).toContain(key2);
    });
  });

  describe("codec-built keys route independently", () => {
    test("routes DM and group to different sessions", () => {
      const dmKey = Channel.SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "dm",
        id: "U001",
      });
      const groupKey = Channel.SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "group",
        id: "C001",
      });

      seedSession("session-dm");
      seedSession("session-group");
      SurfaceKey.claim(dmKey, "session-dm");
      SurfaceKey.claim(groupKey, "session-group");

      expect(SurfaceKey.lookup(dmKey)).toBe("session-dm");
      expect(SurfaceKey.lookup(groupKey)).toBe("session-group");
    });

    test("routes thread separately from parent channel", () => {
      const channelKey = Channel.SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "group",
        id: "C001",
      });
      const threadKey = Channel.SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "group",
        id: "C001",
        threadId: "171000",
      });

      seedSession("session-channel");
      seedSession("session-thread");
      SurfaceKey.claim(channelKey, "session-channel");
      SurfaceKey.claim(threadKey, "session-thread");

      expect(SurfaceKey.lookup(channelKey)).toBe("session-channel");
      expect(SurfaceKey.lookup(threadKey)).toBe("session-thread");
    });

    test("existing keys without explicit kind still claim/lookup", () => {
      const legacyKey = "tui:/Users/ino/Develop/OpenOmni";
      seedSession("session-tui");
      SurfaceKey.claim(legacyKey, "session-tui");
      expect(SurfaceKey.lookup(legacyKey)).toBe("session-tui");
    });
  });

  describe("Storage.reset", () => {
    test("adapter swap leaves no stale mappings", () => {
      const sessionId = "session-123";
      const key1 = "slack:workspaceA:channel:C123";
      const key2 = "slack:workspaceA:channel:C456";

      seedSession(sessionId);
      SurfaceKey.claim(key1, sessionId);
      SurfaceKey.claim(key2, sessionId);

      Storage.reset();
      Storage.initialize({ dbPath: ":memory:" });

      expect(SurfaceKey.lookup(key1)).toBeUndefined();
      expect(SurfaceKey.lookup(key2)).toBeUndefined();
      expect(SurfaceKey.listBySession(sessionId)).toHaveLength(0);
    });
  });

  describe("fail-closed", () => {
    const key = "slack:workspaceA:channel:C123";
    const absentMessage = "does not implement surfaceKey";

    test("every operation throws when the surfaceKey sub-adapter is absent", () => {
      const bare = Storage.get();
      Storage.configure({
        transaction: bare.transaction.bind(bare),
        session: bare.session,
        message: bare.message,
        part: bare.part,
      });

      expect(() => SurfaceKey.claim(key, "session-1")).toThrow(absentMessage);
      expect(() => SurfaceKey.lookup(key)).toThrow(absentMessage);
      expect(() => SurfaceKey.listBySession("session-1")).toThrow(absentMessage);
    });

    test("claim never fabricates a successful claim without persistence", () => {
      const bare = Storage.get();
      Storage.configure({
        transaction: bare.transaction.bind(bare),
        session: bare.session,
        message: bare.message,
        part: bare.part,
      });

      // The pre-#522 fail-open returned the candidate sessionId as if the
      // claim had been persisted; ownership answers must never be fabricated.
      expect(() => SurfaceKey.claim(key, "candidate-session")).toThrow(absentMessage);
    });
  });
});

import { describe, it, expect, beforeEach } from "bun:test";
import { SurfaceKey } from "../src/surface-key";

describe("SurfaceKey", () => {
  beforeEach(() => {
    SurfaceKey.clear();
  });

  describe("create", () => {
    it("creates a valid surfaceKey from parts", () => {
      const key = SurfaceKey.create(["slack", "workspaceA", "channel", "C123"]);
      expect(key).toBe("slack:workspaceA:channel:C123");
    });

    it("creates a surfaceKey with single part and colon", () => {
      const key = SurfaceKey.create(["tui", "/Users/ino/Develop/OpenOmni"]);
      expect(key).toBe("tui:/Users/ino/Develop/OpenOmni");
    });

    it("throws error on empty parts", () => {
      expect(() => SurfaceKey.create([])).toThrow(
        "SurfaceKey parts cannot be empty",
      );
    });

    it("throws error if format validation fails (no colon)", () => {
      expect(() => SurfaceKey.create(["singlepart"])).toThrow(
        /Invalid surfaceKey format/,
      );
    });

    it("creates complex keys with multiple colons", () => {
      const key = SurfaceKey.create([
        "slack",
        "workspaceA",
        "channel",
        "C123",
        "thread",
        "171000",
      ]);
      expect(key).toBe("slack:workspaceA:channel:C123:thread:171000");
    });
  });

  describe("register and lookup", () => {
    it("registers and looks up a surfaceKey", () => {
      const key = "slack:workspaceA:channel:C123";
      const sessionId = "session-123";

      SurfaceKey.register(key, sessionId);
      expect(SurfaceKey.lookup(key)).toBe(sessionId);
    });

    it("returns undefined for unregistered key", () => {
      expect(SurfaceKey.lookup("slack:unknown")).toBeUndefined();
    });

    it("throws error on invalid format during register", () => {
      expect(() => SurfaceKey.register("invalid", "session-123")).toThrow(
        /Invalid surfaceKey format/,
      );
    });

    it("overwrites previous mapping for same key", () => {
      const key = "slack:workspaceA:channel:C123";
      const sessionId1 = "session-1";
      const sessionId2 = "session-2";

      SurfaceKey.register(key, sessionId1);
      expect(SurfaceKey.lookup(key)).toBe(sessionId1);

      SurfaceKey.register(key, sessionId2);
      expect(SurfaceKey.lookup(key)).toBe(sessionId2);
    });
  });

  describe("N:1 mapping (multiple keys → same session)", () => {
    it("allows multiple keys to map to same session", () => {
      const sessionId = "session-123";
      const key1 = "slack:workspaceA:channel:C123";
      const key2 = "slack:workspaceA:channel:C456";

      SurfaceKey.register(key1, sessionId);
      SurfaceKey.register(key2, sessionId);

      expect(SurfaceKey.lookup(key1)).toBe(sessionId);
      expect(SurfaceKey.lookup(key2)).toBe(sessionId);
    });

    it("lists all keys for a session", () => {
      const sessionId = "session-123";
      const key1 = "slack:workspaceA:channel:C123";
      const key2 = "slack:workspaceA:channel:C456";
      const key3 = "telegram:botId:chat:chatId";

      SurfaceKey.register(key1, sessionId);
      SurfaceKey.register(key2, sessionId);
      SurfaceKey.register(key3, sessionId);

      const keys = SurfaceKey.listBySession(sessionId);
      expect(keys).toHaveLength(3);
      expect(keys).toContain(key1);
      expect(keys).toContain(key2);
      expect(keys).toContain(key3);
    });

    it("returns empty array for session with no keys", () => {
      expect(SurfaceKey.listBySession("unknown-session")).toEqual([]);
    });
  });

  describe("unregister", () => {
    it("unregisters a surfaceKey", () => {
      const key = "slack:workspaceA:channel:C123";
      const sessionId = "session-123";

      SurfaceKey.register(key, sessionId);
      expect(SurfaceKey.lookup(key)).toBe(sessionId);

      const removed = SurfaceKey.unregister(key);
      expect(removed).toBe(true);
      expect(SurfaceKey.lookup(key)).toBeUndefined();
    });

    it("returns false when unregistering non-existent key", () => {
      const removed = SurfaceKey.unregister("slack:unknown");
      expect(removed).toBe(false);
    });

    it("removes key from session's key list", () => {
      const sessionId = "session-123";
      const key1 = "slack:workspaceA:channel:C123";
      const key2 = "slack:workspaceA:channel:C456";

      SurfaceKey.register(key1, sessionId);
      SurfaceKey.register(key2, sessionId);

      SurfaceKey.unregister(key1);

      const keys = SurfaceKey.listBySession(sessionId);
      expect(keys).toHaveLength(1);
      expect(keys).toContain(key2);
      expect(keys).not.toContain(key1);
    });

    it("cleans up session entry when last key is removed", () => {
      const sessionId = "session-123";
      const key = "slack:workspaceA:channel:C123";

      SurfaceKey.register(key, sessionId);
      expect(SurfaceKey.listBySession(sessionId)).toHaveLength(1);

      SurfaceKey.unregister(key);
      expect(SurfaceKey.listBySession(sessionId)).toHaveLength(0);
    });
  });

  describe("collision handling", () => {
    it("handles key reassignment from one session to another", () => {
      const key = "slack:workspaceA:channel:C123";
      const sessionId1 = "session-1";
      const sessionId2 = "session-2";

      SurfaceKey.register(key, sessionId1);
      expect(SurfaceKey.lookup(key)).toBe(sessionId1);
      expect(SurfaceKey.listBySession(sessionId1)).toContain(key);

      SurfaceKey.register(key, sessionId2);
      expect(SurfaceKey.lookup(key)).toBe(sessionId2);
      expect(SurfaceKey.listBySession(sessionId1)).not.toContain(key);
      expect(SurfaceKey.listBySession(sessionId2)).toContain(key);
    });

    it("maintains bidirectional consistency", () => {
      const sessionId = "session-123";
      const key1 = "slack:workspaceA:channel:C123";
      const key2 = "slack:workspaceA:channel:C456";

      SurfaceKey.register(key1, sessionId);
      SurfaceKey.register(key2, sessionId);

      expect(SurfaceKey.lookup(key1)).toBe(sessionId);
      expect(SurfaceKey.lookup(key2)).toBe(sessionId);

      const keys = SurfaceKey.listBySession(sessionId);
      expect(keys).toHaveLength(2);
      expect(keys).toContain(key1);
      expect(keys).toContain(key2);
    });
  });

  describe("clear", () => {
    it("clears all mappings", () => {
      const sessionId = "session-123";
      const key1 = "slack:workspaceA:channel:C123";
      const key2 = "slack:workspaceA:channel:C456";

      SurfaceKey.register(key1, sessionId);
      SurfaceKey.register(key2, sessionId);

      SurfaceKey.clear();

      expect(SurfaceKey.lookup(key1)).toBeUndefined();
      expect(SurfaceKey.lookup(key2)).toBeUndefined();
      expect(SurfaceKey.listBySession(sessionId)).toHaveLength(0);
    });
  });
});

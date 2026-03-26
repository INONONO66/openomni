import { describe, test, expect, beforeEach } from "bun:test";
import { SurfaceKey } from "../src/surface-key";

describe("SurfaceKey", () => {
  beforeEach(() => {
    SurfaceKey.clear();
  });

  describe("create", () => {
    test("creates a valid surfaceKey from parts", () => {
      const key = SurfaceKey.create(["slack", "workspaceA", "channel", "C123"]);
      expect(key).toBe("slack:workspaceA:channel:C123");
    });

    test("creates a surfaceKey with single part and colon", () => {
      const key = SurfaceKey.create(["tui", "/Users/ino/Develop/OpenOmni"]);
      expect(key).toBe("tui:/Users/ino/Develop/OpenOmni");
    });

    test("throws error on empty parts", () => {
      expect(() => SurfaceKey.create([])).toThrow("SurfaceKey parts cannot be empty");
    });

    test("throws error if format validation fails (no colon)", () => {
      expect(() => SurfaceKey.create(["singlepart"])).toThrow(/Invalid surfaceKey format/);
    });

    test("creates complex keys with multiple colons", () => {
      const key = SurfaceKey.create(["slack", "workspaceA", "channel", "C123", "thread", "171000"]);
      expect(key).toBe("slack:workspaceA:channel:C123:thread:171000");
    });
  });

  describe("register and lookup", () => {
    test("registers and looks up a surfaceKey", () => {
      const key = "slack:workspaceA:channel:C123";
      const sessionId = "session-123";

      SurfaceKey.register(key, sessionId);
      expect(SurfaceKey.lookup(key)).toBe(sessionId);
    });

    test("returns undefined for unregistered key", () => {
      expect(SurfaceKey.lookup("slack:unknown")).toBeUndefined();
    });

    test("throws error on invalid format during register", () => {
      expect(() => SurfaceKey.register("invalid", "session-123")).toThrow(
        /Invalid surfaceKey format/,
      );
    });

    test("overwrites previous mapping for same key", () => {
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
    test("allows multiple keys to map to same session", () => {
      const sessionId = "session-123";
      const key1 = "slack:workspaceA:channel:C123";
      const key2 = "slack:workspaceA:channel:C456";

      SurfaceKey.register(key1, sessionId);
      SurfaceKey.register(key2, sessionId);

      expect(SurfaceKey.lookup(key1)).toBe(sessionId);
      expect(SurfaceKey.lookup(key2)).toBe(sessionId);
    });

    test("lists all keys for a session", () => {
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

    test("returns empty array for session with no keys", () => {
      expect(SurfaceKey.listBySession("unknown-session")).toEqual([]);
    });
  });

  describe("unregister", () => {
    test("unregisters a surfaceKey", () => {
      const key = "slack:workspaceA:channel:C123";
      const sessionId = "session-123";

      SurfaceKey.register(key, sessionId);
      expect(SurfaceKey.lookup(key)).toBe(sessionId);

      const removed = SurfaceKey.unregister(key);
      expect(removed).toBe(true);
      expect(SurfaceKey.lookup(key)).toBeUndefined();
    });

    test("returns false when unregistering non-existent key", () => {
      const removed = SurfaceKey.unregister("slack:unknown");
      expect(removed).toBe(false);
    });

    test("removes key from session's key list", () => {
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

    test("cleans up session entry when last key is removed", () => {
      const sessionId = "session-123";
      const key = "slack:workspaceA:channel:C123";

      SurfaceKey.register(key, sessionId);
      expect(SurfaceKey.listBySession(sessionId)).toHaveLength(1);

      SurfaceKey.unregister(key);
      expect(SurfaceKey.listBySession(sessionId)).toHaveLength(0);
    });
  });

  describe("collision handling", () => {
    test("handles key reassignment from one session to another", () => {
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

    test("maintains bidirectional consistency", () => {
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

  describe("fromChannel", () => {
    test("creates a DM key", () => {
      const key = SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "workspaceA",
        kind: "dm",
        id: "U123",
      });
      expect(key).toBe("slack:workspaceA:dm:U123");
    });

    test("creates a group key", () => {
      const key = SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "workspaceA",
        kind: "group",
        id: "C456",
      });
      expect(key).toBe("slack:workspaceA:group:C456");
    });

    test("creates a thread key under a group", () => {
      const key = SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "workspaceA",
        kind: "group",
        id: "C456",
        threadId: "171000",
      });
      expect(key).toBe("slack:workspaceA:group:C456:thread:171000");
    });

    test("creates a channel key (backward compat kind)", () => {
      const key = SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "workspaceA",
        kind: "channel",
        id: "C789",
      });
      expect(key).toBe("slack:workspaceA:channel:C789");
    });

    test("creates a telegram chat key", () => {
      const key = SurfaceKey.fromChannel({
        surface: "telegram",
        namespace: "bot123",
        kind: "chat",
        id: "chat456",
      });
      expect(key).toBe("telegram:bot123:chat:chat456");
    });
  });

  describe("parse", () => {
    test("parses a DM key", () => {
      const parsed = SurfaceKey.parse("slack:workspaceA:dm:U123");
      expect(parsed.surface).toBe("slack");
      expect(parsed.namespace).toBe("workspaceA");
      expect(parsed.kind).toBe("dm");
      expect(parsed.id).toBe("U123");
      expect(parsed.threadId).toBeUndefined();
    });

    test("parses a group key", () => {
      const parsed = SurfaceKey.parse("slack:workspaceA:group:C456");
      expect(parsed.kind).toBe("group");
      expect(parsed.id).toBe("C456");
    });

    test("parses a thread key", () => {
      const parsed = SurfaceKey.parse("slack:workspaceA:group:C456:thread:171000");
      expect(parsed.kind).toBe("group");
      expect(parsed.id).toBe("C456");
      expect(parsed.threadId).toBe("171000");
    });

    test("parses a chat key", () => {
      const parsed = SurfaceKey.parse("telegram:bot123:chat:chat456");
      expect(parsed.kind).toBe("chat");
      expect(parsed.id).toBe("chat456");
    });

    test("parses a legacy key without known kind", () => {
      const parsed = SurfaceKey.parse("tui:/Users/ino/Develop/OpenOmni");
      expect(parsed.surface).toBe("tui");
      expect(parsed.namespace).toBe("/Users/ino/Develop/OpenOmni");
      expect(parsed.kind).toBeUndefined();
      expect(parsed.id).toBeUndefined();
    });
  });

  describe("DM vs group vs thread distinction", () => {
    test("produces distinct keys for DM and group in same workspace", () => {
      const dmKey = SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "dm",
        id: "U001",
      });
      const groupKey = SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "group",
        id: "C001",
      });
      expect(dmKey).not.toBe(groupKey);
      expect(dmKey).toContain(":dm:");
      expect(groupKey).toContain(":group:");
    });

    test("produces distinct keys for group and thread in same channel", () => {
      const groupKey = SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "group",
        id: "C001",
      });
      const threadKey = SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "group",
        id: "C001",
        threadId: "171000",
      });
      expect(groupKey).not.toBe(threadKey);
      expect(threadKey).toContain(":thread:");
      expect(groupKey).not.toContain(":thread:");
    });

    test("routes DM and group to different sessions", () => {
      const dmKey = SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "dm",
        id: "U001",
      });
      const groupKey = SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "group",
        id: "C001",
      });

      SurfaceKey.register(dmKey, "session-dm");
      SurfaceKey.register(groupKey, "session-group");

      expect(SurfaceKey.lookup(dmKey)).toBe("session-dm");
      expect(SurfaceKey.lookup(groupKey)).toBe("session-group");
    });

    test("routes thread separately from parent channel", () => {
      const channelKey = SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "group",
        id: "C001",
      });
      const threadKey = SurfaceKey.fromChannel({
        surface: "slack",
        namespace: "ws1",
        kind: "group",
        id: "C001",
        threadId: "171000",
      });

      SurfaceKey.register(channelKey, "session-channel");
      SurfaceKey.register(threadKey, "session-thread");

      expect(SurfaceKey.lookup(channelKey)).toBe("session-channel");
      expect(SurfaceKey.lookup(threadKey)).toBe("session-thread");
    });

    test("roundtrips fromChannel → parse correctly", () => {
      const descriptor: SurfaceKey.ChannelDescriptor = {
        surface: "slack",
        namespace: "ws1",
        kind: "group",
        id: "C001",
        threadId: "171000",
      };
      const key = SurfaceKey.fromChannel(descriptor);
      const parsed = SurfaceKey.parse(key);

      expect(parsed.surface).toBe(descriptor.surface);
      expect(parsed.namespace).toBe(descriptor.namespace);
      expect(parsed.kind).toBe(descriptor.kind);
      expect(parsed.id).toBe(descriptor.id);
      expect(parsed.threadId).toBe(descriptor.threadId);
    });
  });

  describe("backward compatibility", () => {
    test("existing create() API still works unchanged", () => {
      const key = SurfaceKey.create(["slack", "workspaceA", "channel", "C123"]);
      expect(key).toBe("slack:workspaceA:channel:C123");
    });

    test("existing keys without explicit kind still register/lookup", () => {
      const legacyKey = "tui:/Users/ino/Develop/OpenOmni";
      SurfaceKey.register(legacyKey, "session-tui");
      expect(SurfaceKey.lookup(legacyKey)).toBe("session-tui");
    });

    test("parse handles legacy keys gracefully", () => {
      const parsed = SurfaceKey.parse("myservice:some-id");
      expect(parsed.surface).toBe("myservice");
      expect(parsed.namespace).toBe("some-id");
      expect(parsed.kind).toBeUndefined();
    });
  });

  describe("clear", () => {
    test("clears all mappings", () => {
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

import { describe, expect, test } from "bun:test";
import { Channel, SurfaceKeyError } from "../src/channel/index.js";

const SurfaceKey = Channel.SurfaceKey;

describe("Channel.SurfaceKey codec", () => {
  describe("create", () => {
    test("creates a valid surfaceKey from parts", () => {
      const key = SurfaceKey.create(["slack", "workspaceA", "channel", "C123"]);
      expect(key).toBe("slack:workspaceA:channel:C123");
    });

    test("creates a surfaceKey with single part and colon", () => {
      const key = SurfaceKey.create(["tui", "/srv/workspaces/example"]);
      expect(key).toBe("tui:/srv/workspaces/example");
    });

    test("throws error on empty parts", () => {
      expect(() => SurfaceKey.create([])).toThrow(SurfaceKeyError);
    });

    test("throws error if format validation fails (no colon)", () => {
      expect(() => SurfaceKey.create(["singlepart"])).toThrow(SurfaceKeyError);
    });

    test("creates complex keys with multiple colons", () => {
      const key = SurfaceKey.create(["slack", "workspaceA", "channel", "C123", "thread", "171000"]);
      expect(key).toBe("slack:workspaceA:channel:C123:thread:171000");
    });
  });

  describe("assertWellFormed", () => {
    test("returns a well-formed key unchanged", () => {
      expect(SurfaceKey.assertWellFormed("slack:workspaceA")).toBe("slack:workspaceA");
    });

    test("throws on a key without a surface prefix", () => {
      expect(() => SurfaceKey.assertWellFormed("invalid")).toThrow(SurfaceKeyError);
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
  });
});

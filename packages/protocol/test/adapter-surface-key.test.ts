import { describe, expect, test } from "bun:test";
import { Adapter } from "../src/adapter/index.js";

const SurfaceKey = Adapter.SurfaceKey;

describe("Adapter.SurfaceKey codec", () => {
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

  describe("assertWellFormed", () => {
    test("returns a well-formed key unchanged", () => {
      expect(SurfaceKey.assertWellFormed("slack:workspaceA")).toBe("slack:workspaceA");
    });

    test("throws on a key without a surface prefix", () => {
      expect(() => SurfaceKey.assertWellFormed("invalid")).toThrow(/Invalid surfaceKey format/);
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

    test("parse handles legacy keys gracefully", () => {
      const parsed = SurfaceKey.parse("myservice:some-id");
      expect(parsed.surface).toBe("myservice");
      expect(parsed.namespace).toBe("some-id");
      expect(parsed.kind).toBeUndefined();
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

    test("roundtrips fromChannel → parse correctly", () => {
      const descriptor: Adapter.SurfaceKey.ChannelDescriptor = {
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
});

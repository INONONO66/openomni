import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Message } from "@openomni/protocol";
import { FileStorageAdapter } from "../src/file-storage";
import { Storage, InMemoryStorage } from "../src/storage";
import { Session } from "../src/session";

function makeSession(id: string): Session.Info {
  return {
    id,
    title: `Session ${id}`,
    model: { providerID: "test", modelID: "test-model" },
    time: { created: Date.now(), updated: Date.now() },
  };
}

function makeUserMessage(sessionID: string, messageID: string): Message.Info {
  return {
    id: messageID,
    sessionID,
    role: "user" as const,
    time: { created: Date.now() },
    agent: "test-agent",
    model: { providerID: "test", modelID: "test-model" },
  };
}

function makeTextPart(
  sessionID: string,
  messageID: string,
  partID: string,
): Message.Part {
  return {
    id: partID,
    sessionID,
    messageID,
    type: "text" as const,
    text: `Part ${partID} content`,
  };
}

describe("FileStorageAdapter", () => {
  let dir: string;
  let adapter: FileStorageAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openomni-test-"));
    adapter = new FileStorageAdapter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("session", () => {
    it("should set and get a session", () => {
      const session = makeSession("s1");
      adapter.session.set("s1", session);

      const retrieved = adapter.session.get("s1");
      expect(retrieved).toEqual(session);
    });

    it("should return undefined for non-existent session", () => {
      expect(adapter.session.get("nonexistent")).toBeUndefined();
    });

    it("should list all sessions", () => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.session.set("s2", makeSession("s2"));

      const sessions = adapter.session.list();
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    });

    it("should remove a session", () => {
      adapter.session.set("s1", makeSession("s1"));
      expect(adapter.session.remove("s1")).toBe(true);
      expect(adapter.session.get("s1")).toBeUndefined();
    });

    it("should return false when removing non-existent session", () => {
      expect(adapter.session.remove("nonexistent")).toBe(false);
    });

    it("should overwrite existing session on set", () => {
      const session = makeSession("s1");
      adapter.session.set("s1", session);

      const updated = { ...session, title: "Updated Title" };
      adapter.session.set("s1", updated);

      expect(adapter.session.get("s1")?.title).toBe("Updated Title");
    });
  });

  describe("message", () => {
    it("should set and get a message", () => {
      const msg = makeUserMessage("s1", "m1");
      adapter.message.set("s1", msg);

      const retrieved = adapter.message.get("s1", "m1");
      expect(retrieved).toEqual(msg);
    });

    it("should return undefined for non-existent message", () => {
      expect(adapter.message.get("s1", "nonexistent")).toBeUndefined();
    });

    it("should list messages for a session", () => {
      adapter.message.set("s1", makeUserMessage("s1", "m1"));
      adapter.message.set("s1", makeUserMessage("s1", "m2"));
      adapter.message.set("s2", makeUserMessage("s2", "m3"));

      const s1Messages = adapter.message.list("s1");
      expect(s1Messages).toHaveLength(2);
      expect(s1Messages.map((m) => m.id).sort()).toEqual(["m1", "m2"]);

      const s2Messages = adapter.message.list("s2");
      expect(s2Messages).toHaveLength(1);
    });

    it("should return empty array for session with no messages", () => {
      expect(adapter.message.list("empty")).toEqual([]);
    });

    it("should remove a message", () => {
      adapter.message.set("s1", makeUserMessage("s1", "m1"));
      expect(adapter.message.remove("s1", "m1")).toBe(true);
      expect(adapter.message.get("s1", "m1")).toBeUndefined();
    });

    it("should return false when removing non-existent message", () => {
      expect(adapter.message.remove("s1", "nonexistent")).toBe(false);
    });
  });

  describe("part", () => {
    it("should set and get a part", () => {
      const part = makeTextPart("s1", "m1", "p1");
      adapter.part.set("m1", part);

      const retrieved = adapter.part.get("m1", "p1");
      expect(retrieved).toEqual(part);
    });

    it("should return undefined for non-existent part", () => {
      expect(adapter.part.get("m1", "nonexistent")).toBeUndefined();
    });

    it("should list parts for a message", () => {
      adapter.part.set("m1", makeTextPart("s1", "m1", "p1"));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p2"));

      const parts = adapter.part.list("m1");
      expect(parts).toHaveLength(2);
      expect(parts.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    });

    it("should return empty array for message with no parts", () => {
      expect(adapter.part.list("empty")).toEqual([]);
    });

    it("should remove a part", () => {
      adapter.part.set("m1", makeTextPart("s1", "m1", "p1"));
      expect(adapter.part.remove("m1", "p1")).toBe(true);
      expect(adapter.part.get("m1", "p1")).toBeUndefined();
    });

    it("should return false when removing non-existent part", () => {
      expect(adapter.part.remove("m1", "nonexistent")).toBe(false);
    });
  });

  describe("persistence across adapter instances", () => {
    it("should recover session after creating new adapter", () => {
      const session = makeSession("s1");
      adapter.session.set("s1", session);

      const newAdapter = new FileStorageAdapter(dir);
      expect(newAdapter.session.get("s1")).toEqual(session);
    });

    it("should recover messages after creating new adapter", () => {
      const msg = makeUserMessage("s1", "m1");
      adapter.message.set("s1", msg);

      const newAdapter = new FileStorageAdapter(dir);
      expect(newAdapter.message.get("s1", "m1")).toEqual(msg);
      expect(newAdapter.message.list("s1")).toHaveLength(1);
    });

    it("should recover parts after creating new adapter", () => {
      const part = makeTextPart("s1", "m1", "p1");
      adapter.part.set("m1", part);

      const newAdapter = new FileStorageAdapter(dir);
      expect(newAdapter.part.get("m1", "p1")).toEqual(part);
      expect(newAdapter.part.list("m1")).toHaveLength(1);
    });

    it("should recover full session graph after restart", () => {
      const session = makeSession("s1");
      const msg = makeUserMessage("s1", "m1");
      const part = makeTextPart("s1", "m1", "p1");

      adapter.session.set("s1", session);
      adapter.message.set("s1", msg);
      adapter.part.set("m1", part);

      const newAdapter = new FileStorageAdapter(dir);
      expect(newAdapter.session.get("s1")).toEqual(session);
      expect(newAdapter.message.list("s1")).toHaveLength(1);
      expect(newAdapter.part.list("m1")).toHaveLength(1);
    });
  });

  describe("clear", () => {
    it("should remove all data and recreate directory structure", () => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.message.set("s1", makeUserMessage("s1", "m1"));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p1"));

      adapter.clear();

      expect(adapter.session.list()).toEqual([]);
      expect(adapter.message.list("s1")).toEqual([]);
      expect(adapter.part.list("m1")).toEqual([]);
    });
  });
});

describe("Storage.configure with FileStorageAdapter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openomni-test-"));
    Storage.reset();
  });

  afterEach(() => {
    Storage.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("should use InMemoryStorage by default", () => {
    expect(Storage.getAdapter()).toBeInstanceOf(InMemoryStorage);
  });

  it("should accept FileStorageAdapter via Storage.configure", () => {
    const fileAdapter = new FileStorageAdapter(dir);
    Storage.configure(fileAdapter);

    expect(Storage.getAdapter()).toBe(fileAdapter);
  });

  it("should persist via Session API with FileStorageAdapter", () => {
    Storage.configure(new FileStorageAdapter(dir));

    const session = Session.create({
      title: "Persisted Session",
      model: { providerID: "test", modelID: "test-model" },
    });

    Storage.configure(new FileStorageAdapter(dir));

    const recovered = Session.get(session.id);
    expect(recovered).toBeDefined();
    expect(recovered?.title).toBe("Persisted Session");
  });

  it("should restore to InMemoryStorage on Storage.reset", () => {
    Storage.configure(new FileStorageAdapter(dir));
    Storage.reset();

    expect(Storage.getAdapter()).toBeInstanceOf(InMemoryStorage);
  });
});

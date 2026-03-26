import { describe, expect, test, beforeEach, spyOn } from "bun:test";
import type { Message } from "@openomni/protocol";
import { InMemoryStorage } from "../../src/storage/storage";
import { CachedStorageAdapter } from "../../src/storage/cache";
import { Session } from "../../src/session";

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

function makeTextPart(sessionID: string, messageID: string, partID: string): Message.Part {
  return {
    id: partID,
    sessionID,
    messageID,
    type: "text" as const,
    text: `Part ${partID} content`,
  };
}

describe("CachedStorageAdapter", () => {
  let underlying: InMemoryStorage;
  let cached: CachedStorageAdapter;

  beforeEach(() => {
    underlying = new InMemoryStorage();
    cached = new CachedStorageAdapter(underlying);
  });

  describe("session", () => {
    test("get: first call hits underlying, second call hits cache", () => {
      const session = makeSession("s1");
      underlying.session.set("s1", session);

      const getSpy = spyOn(underlying.session, "get");

      const result1 = cached.session.get("s1");
      expect(result1).toEqual(session);
      expect(getSpy).toHaveBeenCalledTimes(1);

      const result2 = cached.session.get("s1");
      expect(result2).toEqual(session);
      expect(getSpy).toHaveBeenCalledTimes(1);
    });

    test("set: write-through writes to underlying", () => {
      const session = makeSession("s1");
      cached.session.set("s1", session);

      const fromUnderlying = underlying.session.get("s1");
      expect(fromUnderlying).toEqual(session);

      const getSpy = spyOn(underlying.session, "get");
      const fromCache = cached.session.get("s1");
      expect(fromCache).toEqual(session);
      expect(getSpy).toHaveBeenCalledTimes(0);
    });

    test("remove: invalidates cache", () => {
      const session = makeSession("s1");
      cached.session.set("s1", session);

      expect(cached.session.remove("s1")).toBe(true);
      expect(cached.session.get("s1")).toBeUndefined();
    });

    test("remove: returns false for non-existent session", () => {
      expect(cached.session.remove("nonexistent")).toBe(false);
    });

    test("list: first call loads all, second call from cache", () => {
      underlying.session.set("s1", makeSession("s1"));
      underlying.session.set("s2", makeSession("s2"));

      const listSpy = spyOn(underlying.session, "list");

      const result1 = cached.session.list();
      expect(result1).toHaveLength(2);
      expect(listSpy).toHaveBeenCalledTimes(1);

      const result2 = cached.session.list();
      expect(result2).toHaveLength(2);
      expect(listSpy).toHaveBeenCalledTimes(1);
    });

    test("set: invalidates session list cache", () => {
      underlying.session.set("s1", makeSession("s1"));

      cached.session.list();
      const listSpy = spyOn(underlying.session, "list");

      cached.session.set("s2", makeSession("s2"));

      const result = cached.session.list();
      expect(result).toHaveLength(2);
      expect(listSpy).toHaveBeenCalledTimes(1);
    });

    test("remove: invalidates session list cache", () => {
      cached.session.set("s1", makeSession("s1"));
      cached.session.set("s2", makeSession("s2"));

      cached.session.list();
      const listSpy = spyOn(underlying.session, "list");

      cached.session.remove("s1");

      cached.session.list();
      expect(listSpy).toHaveBeenCalledTimes(1);
    });

    test("get: returns undefined for non-existent session and caches miss", () => {
      const getSpy = spyOn(underlying.session, "get");

      expect(cached.session.get("nope")).toBeUndefined();
      expect(getSpy).toHaveBeenCalledTimes(1);

      expect(cached.session.get("nope")).toBeUndefined();
      expect(getSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("message", () => {
    test("list: first call hits underlying, second call hits cache", () => {
      const msg = makeUserMessage("s1", "m1");
      underlying.message.set("s1", msg);

      const listSpy = spyOn(underlying.message, "list");

      const result1 = cached.message.list("s1");
      expect(result1).toHaveLength(1);
      expect(listSpy).toHaveBeenCalledTimes(1);

      const result2 = cached.message.list("s1");
      expect(result2).toHaveLength(1);
      expect(listSpy).toHaveBeenCalledTimes(1);
    });

    test("get: finds message from cached list", () => {
      const msg = makeUserMessage("s1", "m1");
      underlying.message.set("s1", msg);

      const result = cached.message.get("s1", "m1");
      expect(result).toEqual(msg);
    });

    test("get: returns undefined for non-existent message", () => {
      expect(cached.message.get("s1", "nope")).toBeUndefined();
    });

    test("set: upsert - set message twice returns single updated message", () => {
      const msg1 = makeUserMessage("s1", "m1");
      cached.message.set("s1", msg1);

      const msg2 = { ...msg1, agent: "updated-agent" };
      cached.message.set("s1", msg2);

      const list = cached.message.list("s1");
      expect(list).toHaveLength(1);
      expect(list[0]!.agent).toBe("updated-agent");

      const underlyingList = underlying.message.list("s1");
      expect(underlyingList).toHaveLength(1);
      expect(underlyingList[0]!.agent).toBe("updated-agent");
    });

    test("set: invalidates cache when list not yet cached", () => {
      underlying.message.set("s1", makeUserMessage("s1", "m1"));

      const msg2 = makeUserMessage("s1", "m2");
      cached.message.set("s1", msg2);

      const list = cached.message.list("s1");
      expect(list).toHaveLength(2);
    });

    test("remove: invalidates list cache", () => {
      cached.message.set("s1", makeUserMessage("s1", "m1"));
      cached.message.set("s1", makeUserMessage("s1", "m2"));

      expect(cached.message.list("s1")).toHaveLength(2);

      cached.message.remove("s1", "m1");

      const list = cached.message.list("s1");
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe("m2");
    });

    test("remove: returns false for non-existent message", () => {
      expect(cached.message.remove("s1", "nope")).toBe(false);
    });
  });

  describe("part", () => {
    test("list: first call hits underlying, second call hits cache", () => {
      const part = makeTextPart("s1", "m1", "p1");
      underlying.part.set("m1", part);

      const listSpy = spyOn(underlying.part, "list");

      const result1 = cached.part.list("m1");
      expect(result1).toHaveLength(1);
      expect(listSpy).toHaveBeenCalledTimes(1);

      const result2 = cached.part.list("m1");
      expect(result2).toHaveLength(1);
      expect(listSpy).toHaveBeenCalledTimes(1);
    });

    test("get: finds part from cached list", () => {
      const part = makeTextPart("s1", "m1", "p1");
      underlying.part.set("m1", part);

      const result = cached.part.get("m1", "p1");
      expect(result).toEqual(part);
    });

    test("get: returns undefined for non-existent part", () => {
      expect(cached.part.get("m1", "nope")).toBeUndefined();
    });

    test("set: upsert - set part twice returns single updated part", () => {
      const part1 = makeTextPart("s1", "m1", "p1");
      cached.part.set("m1", part1);

      const part2 = { ...part1, text: "updated content" } as Message.Part;
      cached.part.set("m1", part2);

      const list = cached.part.list("m1");
      expect(list).toHaveLength(1);
      expect((list[0] as { text: string }).text).toBe("updated content");
    });

    test("remove: invalidates cache entry", () => {
      cached.part.set("m1", makeTextPart("s1", "m1", "p1"));
      cached.part.set("m1", makeTextPart("s1", "m1", "p2"));

      expect(cached.part.list("m1")).toHaveLength(2);

      cached.part.remove("m1", "p1");

      const list = cached.part.list("m1");
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe("p2");
    });

    test("remove: returns false for non-existent part", () => {
      expect(cached.part.remove("m1", "nope")).toBe(false);
    });
  });

  describe("clear", () => {
    test("resets all caches", () => {
      cached.session.set("s1", makeSession("s1"));
      cached.message.set("s1", makeUserMessage("s1", "m1"));
      cached.part.set("m1", makeTextPart("s1", "m1", "p1"));

      cached.session.list();
      cached.message.list("s1");
      cached.part.list("m1");

      cached.clear();

      expect(cached.session.get("s1")).toBeUndefined();
      expect(cached.message.list("s1")).toHaveLength(0);
      expect(cached.part.list("m1")).toHaveLength(0);
      expect(cached.session.list()).toHaveLength(0);
    });

    test("calls underlying clear if available", () => {
      const clearSpy = spyOn(underlying, "clear");
      cached.clear();
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    test("works when underlying has no clear method", () => {
      const noClearAdapter: CachedStorageAdapter = new CachedStorageAdapter({
        session: underlying.session,
        message: underlying.message,
        part: underlying.part,
      });

      expect(() => noClearAdapter.clear()).not.toThrow();
    });
  });
});

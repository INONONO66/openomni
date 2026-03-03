import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@openomni/protocol";
import type { SessionInfo } from "../../src/session/info";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";

function makeSession(id: string): SessionInfo {
  return {
    id,
    title: `Session ${id}`,
    model: { providerID: "test", modelID: "test-model" },
    time: { created: Date.now(), updated: Date.now() },
  };
}

function makeUserMessage(
  sessionID: string,
  messageID: string,
  timeCreated?: number,
): Message.Info {
  return {
    id: messageID,
    sessionID,
    role: "user",
    time: { created: timeCreated ?? Date.now() },
    agent: "test-agent",
    model: { providerID: "test", modelID: "test-model" },
  };
}

function makeTextPart(
  sessionID: string,
  messageID: string,
  partID: string,
  timeStart?: number,
): Message.Part {
  return {
    id: partID,
    sessionID,
    messageID,
    type: "text",
    text: `Part ${partID} content`,
    time: timeStart === undefined ? undefined : { start: timeStart },
  };
}

function makeToolPart(
  sessionID: string,
  messageID: string,
  partID: string,
  status: string,
  timeStart?: number,
): Message.Part {
  const base = {
    id: partID,
    sessionID,
    messageID,
    type: "tool" as const,
    callID: `call-${partID}`,
    tool: "test-tool",
  };

  if (status === "pending") {
    return {
      ...base,
      state: {
        status: "pending",
        input: {},
      },
    };
  }

  if (status === "running") {
    return {
      ...base,
      state: {
        status: "running",
        input: {},
        time: { start: timeStart ?? Date.now() },
      },
    };
  }

  if (status === "completed") {
    const start = timeStart ?? Date.now();
    return {
      ...base,
      state: {
        status: "completed",
        input: {},
        output: "ok",
        title: "done",
        metadata: {},
        time: { start, end: start + 1 },
      },
    };
  }

  if (status === "error") {
    const start = timeStart ?? Date.now();
    return {
      ...base,
      state: {
        status: "error",
        input: {},
        error: "failed",
        time: { start, end: start + 1 },
      },
    };
  }

  throw new Error(`Unsupported tool status: ${status}`);
}

describe("SqliteStorageAdapter", () => {
  let dbPath = "";
  let adapter: SqliteStorageAdapter;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `test-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    adapter = new SqliteStorageAdapter(dbPath);
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch {}
    unlinkSync(dbPath);
  });

  describe("session", () => {
    test("get: returns undefined for non-existent", () => {
      expect(adapter.session.get("missing")).toBeUndefined();
    });

    test("get: returns session after set", () => {
      const session = makeSession("s1");
      adapter.session.set("s1", session);

      expect(adapter.session.get("s1")).toEqual(session);
    });

    test("set: overwrites existing session (upsert)", () => {
      const session = makeSession("s1");
      adapter.session.set("s1", session);

      const updated: SessionInfo = {
        ...session,
        title: "Updated Session",
        time: { ...session.time, updated: session.time.updated + 1 },
      };
      adapter.session.set("s1", updated);

      expect(adapter.session.get("s1")).toEqual(updated);
      expect(adapter.session.list()).toHaveLength(1);
    });

    test("list: returns empty array initially", () => {
      expect(adapter.session.list()).toEqual([]);
    });

    test("list: returns all sessions", () => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.session.set("s2", makeSession("s2"));

      const list = adapter.session.list();
      expect(list).toHaveLength(2);
      expect(list.map((item) => item.id).sort()).toEqual(["s1", "s2"]);
    });

    test("remove: returns true and deletes", () => {
      adapter.session.set("s1", makeSession("s1"));

      expect(adapter.session.remove("s1")).toBe(true);
      expect(adapter.session.get("s1")).toBeUndefined();
      expect(adapter.session.list()).toEqual([]);
    });

    test("remove: returns false for non-existent", () => {
      expect(adapter.session.remove("missing")).toBe(false);
    });
  });

  describe("message", () => {
    test("get: returns undefined for non-existent", () => {
      expect(adapter.message.get("s1", "m1")).toBeUndefined();
    });

    test("get: returns message after set", () => {
      const message = makeUserMessage("s1", "m1");
      adapter.message.set("s1", message);

      expect(adapter.message.get("s1", "m1")).toEqual(message);
    });

    test("set: upsert - updating existing message", () => {
      const initial = makeUserMessage("s1", "m1", 100);
      adapter.message.set("s1", initial);

      const updated = {
        ...initial,
        agent: "updated-agent",
      };
      adapter.message.set("s1", updated);

      expect(adapter.message.get("s1", "m1")).toEqual(updated);
      expect(adapter.message.list("s1")).toHaveLength(1);
    });

    test("list: returns empty array for unknown session", () => {
      expect(adapter.message.list("unknown")).toEqual([]);
    });

    test("list: returns messages sorted by time_created ASC, id ASC", () => {
      adapter.message.set("s1", makeUserMessage("s1", "m2", 200));
      adapter.message.set("s1", makeUserMessage("s1", "m1", 100));
      adapter.message.set("s1", makeUserMessage("s1", "m3", 200));

      const list = adapter.message.list("s1");
      expect(list.map((item) => item.id)).toEqual(["m1", "m2", "m3"]);
    });

    test("list: only returns messages for the given session", () => {
      adapter.message.set("s1", makeUserMessage("s1", "m1", 1));
      adapter.message.set("s2", makeUserMessage("s2", "m2", 2));

      const list = adapter.message.list("s1");
      expect(list.map((item) => item.id)).toEqual(["m1"]);
    });

    test("remove: returns true and deletes", () => {
      adapter.message.set("s1", makeUserMessage("s1", "m1"));

      expect(adapter.message.remove("s1", "m1")).toBe(true);
      expect(adapter.message.get("s1", "m1")).toBeUndefined();
      expect(adapter.message.list("s1")).toEqual([]);
    });

    test("remove: returns false for non-existent", () => {
      expect(adapter.message.remove("s1", "missing")).toBe(false);
    });
  });

  describe("part", () => {
    test("get: returns undefined for non-existent", () => {
      expect(adapter.part.get("m1", "p1")).toBeUndefined();
    });

    test("get: returns part after set", () => {
      const part = makeTextPart("s1", "m1", "p1", 100);
      adapter.part.set("m1", part);

      expect(adapter.part.get("m1", "p1")).toEqual(part);
    });

    test("set: upsert - updating existing part", () => {
      const initial = makeTextPart("s1", "m1", "p1", 100);
      adapter.part.set("m1", initial);

      const updated: Message.Part = {
        ...initial,
        text: "updated",
      };
      adapter.part.set("m1", updated);

      expect(adapter.part.get("m1", "p1")).toEqual(updated);
      expect(adapter.part.list("m1")).toHaveLength(1);
    });

    test("list: returns empty array for unknown message", () => {
      expect(adapter.part.list("unknown")).toEqual([]);
    });

    test("list: returns parts sorted by time_start (nulls last), then id", () => {
      adapter.part.set("m1", makeTextPart("s1", "m1", "p4"));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p2", 200));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p3", 200));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p1", 100));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p0"));

      const list = adapter.part.list("m1");
      expect(list.map((item) => item.id)).toEqual([
        "p1",
        "p2",
        "p3",
        "p0",
        "p4",
      ]);
    });

    test("list: only returns parts for the given message", () => {
      adapter.part.set("m1", makeTextPart("s1", "m1", "p1", 100));
      adapter.part.set("m2", makeTextPart("s1", "m2", "p2", 100));

      const list = adapter.part.list("m1");
      expect(list.map((item) => item.id)).toEqual(["p1"]);
    });

    test("remove: returns true and deletes", () => {
      adapter.part.set("m1", makeTextPart("s1", "m1", "p1", 100));

      expect(adapter.part.remove("m1", "p1")).toBe(true);
      expect(adapter.part.get("m1", "p1")).toBeUndefined();
      expect(adapter.part.list("m1")).toEqual([]);
    });

    test("remove: returns false for non-existent", () => {
      expect(adapter.part.remove("m1", "missing")).toBe(false);
    });
  });

  describe("sorting", () => {
    test("message list sorts by time_created ascending, with id as tiebreaker", () => {
      adapter.message.set("s1", makeUserMessage("s1", "m-c", 300));
      adapter.message.set("s1", makeUserMessage("s1", "m-a", 100));
      adapter.message.set("s1", makeUserMessage("s1", "m-b", 100));
      adapter.message.set("s1", makeUserMessage("s1", "m-d", 200));

      const list = adapter.message.list("s1");
      expect(list.map((item) => item.id)).toEqual(["m-a", "m-b", "m-d", "m-c"]);
    });

    test("part list: parts with time_start come before parts without", () => {
      adapter.part.set("m1", makeTextPart("s1", "m1", "p-no-time"));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p-with-time", 10));

      const list = adapter.part.list("m1");
      expect(list.map((item) => item.id)).toEqual(["p-with-time", "p-no-time"]);
    });

    test("part list: tool parts with non-pending state use state.time.start for sorting", () => {
      adapter.part.set(
        "m1",
        makeToolPart("s1", "m1", "tool-pending", "pending"),
      );
      adapter.part.set(
        "m1",
        makeToolPart("s1", "m1", "tool-running", "running", 300),
      );
      adapter.part.set(
        "m1",
        makeToolPart("s1", "m1", "tool-completed", "completed", 100),
      );
      adapter.part.set("m1", makeToolPart("s1", "m1", "text", "error", 200));

      const list = adapter.part.list("m1");
      expect(list.map((item) => item.id)).toEqual([
        "tool-completed",
        "text",
        "tool-running",
        "tool-pending",
      ]);
    });

    test("part list: parts without time_start are sorted by id", () => {
      adapter.part.set("m1", makeTextPart("s1", "m1", "z-no-time"));
      adapter.part.set("m1", makeTextPart("s1", "m1", "a-no-time"));
      adapter.part.set("m1", makeToolPart("s1", "m1", "m-pending", "pending"));

      const list = adapter.part.list("m1");
      expect(list.map((item) => item.id)).toEqual([
        "a-no-time",
        "m-pending",
        "z-no-time",
      ]);
    });
  });

  describe("clear", () => {
    test("clears all data from all tables", () => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.message.set("s1", makeUserMessage("s1", "m1"));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p1", 10));

      adapter.clear();

      expect(adapter.session.list()).toEqual([]);
      expect(adapter.message.list("s1")).toEqual([]);
      expect(adapter.part.list("m1")).toEqual([]);
    });

    test("get/list return empty after clear", () => {
      const session = makeSession("s1");
      const message = makeUserMessage("s1", "m1");
      const part = makeTextPart("s1", "m1", "p1", 10);

      adapter.session.set("s1", session);
      adapter.message.set("s1", message);
      adapter.part.set("m1", part);

      adapter.clear();

      expect(adapter.session.get("s1")).toBeUndefined();
      expect(adapter.session.list()).toEqual([]);
      expect(adapter.message.get("s1", "m1")).toBeUndefined();
      expect(adapter.message.list("s1")).toEqual([]);
      expect(adapter.part.get("m1", "p1")).toBeUndefined();
      expect(adapter.part.list("m1")).toEqual([]);
    });
  });

  describe("close", () => {
    test("close() doesn't throw", () => {
      expect(() => adapter.close()).not.toThrow();
    });

    test("operations after close throw (or handle gracefully)", () => {
      adapter.close();
      expect(() => adapter.session.list()).toThrow();
    });
  });
});

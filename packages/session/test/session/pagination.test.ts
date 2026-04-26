import { beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Session } from "../../src/session";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";

function makeUserMessage(sessionID: string, index: number): Message.UserMessage {
  return {
    id: `msg-${index.toString().padStart(3, "0")}`,
    sessionID,
    role: "user",
    time: { created: index },
    agent: "test-agent",
    model: { providerID: "test", modelID: "test-model" },
  };
}

describe("Session.listMessagesPage", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("returns paged items with cursor and more flag", () => {
    const session = Session.create({
      title: "Pagination",
      model: { providerID: "test", modelID: "test-model" },
    });

    for (let i = 1; i <= 100; i++) {
      Session.addMessage(session.id, makeUserMessage(session.id, i));
    }

    const page1 = Session.listMessagesPage(session.id, { limit: 10 });
    expect(page1.items).toHaveLength(10);
    expect(page1.more).toBe(true);
    expect(typeof page1.nextCursor).toBe("string");
    expect(page1.items.map((item) => item.id)).toEqual([
      "msg-091",
      "msg-092",
      "msg-093",
      "msg-094",
      "msg-095",
      "msg-096",
      "msg-097",
      "msg-098",
      "msg-099",
      "msg-100",
    ]);

    const page2 = Session.listMessagesPage(session.id, { limit: 10, before: page1.nextCursor! });
    expect(page2.items).toHaveLength(10);
    expect(page2.more).toBe(true);
    expect(typeof page2.nextCursor).toBe("string");
    expect(page2.items.map((item) => item.id)).toEqual([
      "msg-081",
      "msg-082",
      "msg-083",
      "msg-084",
      "msg-085",
      "msg-086",
      "msg-087",
      "msg-088",
      "msg-089",
      "msg-090",
    ]);
  });

  test("returns empty page for empty session", () => {
    const session = Session.create({
      title: "Empty",
      model: { providerID: "test", modelID: "test-model" },
    });

    const page = Session.listMessagesPage(session.id, { limit: 10 });
    expect(page.items).toEqual([]);
    expect(page.more).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

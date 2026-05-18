import { beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "../../../protocol/src/message/index.ts";
import { Bus } from "../../src/bus/index.ts";
import { Session } from "../../src/session/index.ts";
import { Snapshot } from "../../src/snapshot/index.ts";
import { Storage } from "../../src/storage/storage.ts";

function measureRSS(): number {
  Bun.gc(true);
  return process.memoryUsage().rss;
}

function createMemoryStorage(): Storage.Adapter {
  const sessions = new Map<string, Session.Info>();
  const messages = new Map<string, Map<string, Message.Info>>();
  const parts = new Map<string, Map<string, Message.Part>>();

  return {
    session: {
      get(id) {
        return sessions.get(id);
      },
      set(id, info) {
        sessions.set(id, info);
      },
      list() {
        return [...sessions.values()];
      },
      remove(id) {
        return sessions.delete(id);
      },
    },
    message: {
      get(sessionID, messageID) {
        return messages.get(sessionID)?.get(messageID);
      },
      set(sessionID, message) {
        const sessionMessages = messages.get(sessionID) ?? new Map<string, Message.Info>();
        sessionMessages.set(message.id, message);
        messages.set(sessionID, sessionMessages);
      },
      list(sessionID) {
        return [...(messages.get(sessionID)?.values() ?? [])];
      },
      remove(sessionID, messageID) {
        const sessionMessages = messages.get(sessionID);
        if (!sessionMessages) return false;
        const removed = sessionMessages.delete(messageID);
        if (sessionMessages.size === 0) messages.delete(sessionID);
        return removed;
      },
    },
    part: {
      get(messageID, partID) {
        return parts.get(messageID)?.get(partID);
      },
      set(messageID, part) {
        const messageParts = parts.get(messageID) ?? new Map<string, Message.Part>();
        messageParts.set(part.id, part);
        parts.set(messageID, messageParts);
      },
      list(messageID) {
        return [...(parts.get(messageID)?.values() ?? [])];
      },
      remove(messageID, partID) {
        const messageParts = parts.get(messageID);
        if (!messageParts) return false;
        const removed = messageParts.delete(partID);
        if (messageParts.size === 0) parts.delete(messageID);
        return removed;
      },
    },
  };
}

function createSession(index: number): Session.Info {
  return Session.create({
    title: `memory-regression-${index}`,
    model: { providerID: "test", modelID: "test-model" },
  });
}

function createMessage(sessionID: string, index: number): Message.UserMessage {
  return {
    id: `${sessionID}-message-${index}`,
    sessionID,
    role: "user",
    time: { created: index },
    agent: "memory-regression",
    model: { providerID: "test", modelID: "test-model" },
  };
}

function createTextPart(sessionID: string, messageID: string, index: number): Message.TextPart {
  return {
    id: `${messageID}-part-${index}`,
    sessionID,
    messageID,
    type: "text",
    text: `snapshot payload ${index}`,
    time: { start: index },
  };
}

describe("session memory regression", () => {
  beforeEach(() => {
    Storage.configure(createMemoryStorage());
    Snapshot.reset();
    Bus.reset();
  });

  test("session create/delete does not leak", () => {
    const baseline = measureRSS();

    for (let index = 0; index < 200; index += 1) {
      const session = createSession(index);
      Session.remove(session.id);
    }

    const final = measureRSS();
    const growthMB = (final - baseline) / 1024 / 1024;
    expect(growthMB).toBeLessThan(10);
  }, 30_000);

  test("bus subscribe/publish/unsubscribe does not leak", async () => {
    const baseline = measureRSS();

    for (let index = 0; index < 500; index += 1) {
      const unsubscribe = Bus.subscribe(Session.Event.Deleted, () => {
        /* noop handler for leak test */
      });
      for (let eventIndex = 0; eventIndex < 10; eventIndex += 1) {
        Bus.publish(Session.Event.Deleted, { id: `${index}-${eventIndex}` });
      }
      unsubscribe();
    }

    Bus.reset();
    await new Promise((resolve) => queueMicrotask(resolve));
    const final = measureRSS();
    const growthMB = (final - baseline) / 1024 / 1024;
    expect(growthMB).toBeLessThan(5);
  }, 30_000);

  test("snapshot create/delete does not leak", () => {
    const session = createSession(0);
    const baseline = measureRSS();

    for (let index = 0; index < 200; index += 1) {
      const message = createMessage(session.id, index);
      Session.addMessage(session.id, message);
      Session.addPart(message.id, createTextPart(session.id, message.id, index));
      const snapshotID = Snapshot.track(session.id);
      Snapshot.remove(snapshotID);
      Storage.getAdapter().part.remove(message.id, `${message.id}-part-${index}`);
      Storage.getAdapter().message.remove(session.id, message.id);
    }

    Session.remove(session.id);
    const final = measureRSS();
    const growthMB = (final - baseline) / 1024 / 1024;
    expect(growthMB).toBeLessThan(5);
  }, 30_000);

  test("storage adapter session CRUD does not leak", () => {
    const adapter = Storage.getAdapter();
    const warmupSession = createSession(0);
    Session.remove(warmupSession.id);
    const baseline = measureRSS();

    for (let index = 0; index < 500; index += 1) {
      const now = Date.now();
      const session: Session.Info = {
        id: `storage-${index}`,
        title: `storage session ${index}`,
        model: { providerID: "test", modelID: "test-model" },
        time: { created: now, updated: now },
        spawnDepth: 0,
      };
      adapter.session.set(session.id, session);
      if (adapter.session.get(session.id)?.id !== session.id) {
        throw new Error(`session ${session.id} was not persisted`);
      }
      adapter.session.remove(session.id);
    }

    const final = measureRSS();
    const growthMB = (final - baseline) / 1024 / 1024;
    expect(growthMB).toBeLessThan(5);
  }, 30_000);
});

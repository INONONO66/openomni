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

function makeTextPart(sessionID: string, messageID: string, index: number): Message.TextPart {
  return {
    id: `${messageID}-part-${index.toString().padStart(2, "0")}`,
    sessionID,
    messageID,
    type: "text",
    text: `part-${index}`,
    time: { start: index },
  };
}

describe("Session.hydrateMessages", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("hydrates messages with all parts", async () => {
    const session = Session.create({
      traceId: "trace-hydration",
      title: "Hydration",
      model: { providerID: "test", modelID: "test-model" },
    });

    for (let i = 1; i <= 10; i++) {
      const message = makeUserMessage(session.id, i);
      Session.addMessage(session.id, message);
      for (let j = 1; j <= 5; j++) {
        Session.addPart(message.id, makeTextPart(session.id, message.id, j));
      }
    }

    const messages = Session.getMessages(session.id);
    const hydrated = await Session.hydrateMessages(messages);

    expect(hydrated).toHaveLength(10);
    for (const item of hydrated) {
      expect(item.parts).toHaveLength(5);
      expect(item.info.id.startsWith("msg-")).toBe(true);
    }
  });
});

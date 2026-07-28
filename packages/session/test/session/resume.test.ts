import { beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Session } from "../../src/session";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";

function createSession() {
  return Session.create({
    title: "Resume",
    model: { providerID: "test", modelID: "test-model" },
  });
}

function userMessage(sessionID: string, id: string, created: number): Message.UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "test-agent",
    model: { providerID: "test", modelID: "test-model" },
  };
}

function assistantMessage(
  sessionID: string,
  id: string,
  created: number,
  parentID = "user-1",
): Message.AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created },
    parentID,
    modelID: "test-model",
    providerID: "test",
    agent: "test-agent",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: {
      input: 1,
      output: 2,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function textPart(
  sessionID: string,
  messageID: string,
  id: string,
  text: string,
): Message.TextPart {
  return {
    id,
    sessionID,
    messageID,
    type: "text",
    text,
    time: { start: 0 },
  };
}

describe("Session resume and abandon APIs", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("resume recovers assistant text messages with stable sequence metadata", async () => {
    const session = createSession();
    const user = userMessage(session.id, "user-1", Date.UTC(2026, 0, 1));
    const assistantOne = assistantMessage(session.id, "assistant-1", Date.UTC(2026, 0, 2));
    const assistantEmpty = assistantMessage(session.id, "assistant-empty", Date.UTC(2026, 0, 3));
    const assistantTwo = assistantMessage(session.id, "assistant-2", Date.UTC(2026, 0, 4));

    Session.addMessage(session.id, user);
    Session.addMessage(session.id, assistantOne);
    Session.addPart(
      assistantOne.id,
      textPart(session.id, assistantOne.id, "assistant-1-text-1", "first"),
    );
    Session.addPart(
      assistantOne.id,
      textPart(session.id, assistantOne.id, "assistant-1-text-2", "second"),
    );
    Session.addMessage(session.id, assistantEmpty);
    Session.addMessage(session.id, assistantTwo);
    Session.addPart(
      assistantTwo.id,
      textPart(session.id, assistantTwo.id, "assistant-2-text-1", "third"),
    );

    await expect(Session.resume(session.id)).resolves.toEqual([
      {
        role: "assistant",
        text: "first\nsecond",
        timestamp: new Date(Date.UTC(2026, 0, 2)).toISOString(),
        sequence: 1,
        turnIndex: 0,
      },
      {
        role: "assistant",
        text: "third",
        timestamp: new Date(Date.UTC(2026, 0, 4)).toISOString(),
        sequence: 2,
        turnIndex: 1,
      },
    ]);
  });

  test("suspend and abandon report existence and remove session data", async () => {
    const session = createSession();
    const user = userMessage(session.id, "user-abandon", Date.UTC(2026, 0, 1));
    const assistant = assistantMessage(session.id, "assistant-1", Date.UTC(2026, 0, 2), user.id);
    Session.addMessage(session.id, user);
    Session.addMessage(session.id, assistant);
    Session.addPart(assistant.id, textPart(session.id, assistant.id, "text-1", "persisted"));

    await expect(Session.suspend(session.id)).resolves.toBe(true);
    await expect(Session.suspend("missing-session")).resolves.toBe(false);

    await expect(Session.abandon(session.id)).resolves.toBe(true);
    expect(Session.get(session.id)).toBeUndefined();
    expect(Session.getMessages(session.id)).toEqual([]);
    expect(Session.getParts(assistant.id)).toEqual([]);
    await expect(Session.abandon(session.id)).resolves.toBe(false);
  });
});

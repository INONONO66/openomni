import { beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@openomni/protocol";
import { Session } from "../../src/session";
import { Snapshot } from "../../src/snapshot";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";

function createSession() {
  return Session.create({
    title: "Snapshot",
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

function addMessageWithText(sessionID: string, messageID: string, text: string, created = 1): void {
  const message = userMessage(sessionID, messageID, created);
  Session.addMessage(sessionID, message);
  Session.addPart(messageID, textPart(sessionID, messageID, `${messageID}-text`, text));
}

describe("Snapshot provider", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    Snapshot.reset();
  });

  test("restore replaces current messages and parts with the tracked snapshot", () => {
    const session = createSession();
    addMessageWithText(session.id, "tracked", "original", 1);
    const snapshotID = Snapshot.track(session.id);

    Session.addPart("tracked", textPart(session.id, "tracked", "tracked-extra", "mutated"));
    addMessageWithText(session.id, "later", "remove me", 2);

    Snapshot.restore(session.id, snapshotID);

    expect(Session.getMessages(session.id).map((message) => message.id)).toEqual(["tracked"]);
    expect(Session.getParts("tracked").map((part) => part.id)).toEqual(["tracked-text"]);
    expect(Session.getParts("later")).toEqual([]);
  });

  test("diff reports structural added, removed, and part-count modified messages", () => {
    const session = createSession();
    addMessageWithText(session.id, "kept", "kept", 1);
    addMessageWithText(session.id, "removed", "removed", 2);
    const snapshotID = Snapshot.track(session.id);

    Session.addPart("kept", textPart(session.id, "kept", "kept-extra", "new part"));

    // Provider-level diff is structural today: message ID membership plus part count.
    // Remove directly through the adapter to exercise the missing-message path
    // without adding a production deletion API just for this fixture.
    Storage.getAdapter().message.remove(session.id, "removed");
    addMessageWithText(session.id, "added", "added", 3);

    expect(Snapshot.diff(session.id, snapshotID)).toEqual({
      added: ["added"],
      removed: ["removed"],
      modified: ["kept"],
    });
  });

  test("empty snapshots restore by clearing messages added later", () => {
    const session = createSession();
    const snapshotID = Snapshot.track(session.id);

    addMessageWithText(session.id, "later", "remove me", 1);

    expect(Snapshot.diff(session.id, snapshotID)).toEqual({
      added: ["later"],
      removed: [],
      modified: [],
    });

    Snapshot.restore(session.id, snapshotID);

    expect(Session.getMessages(session.id)).toEqual([]);
    expect(Session.getParts("later")).toEqual([]);
  });

  test("missing snapshots throw for restore and diff", () => {
    const session = createSession();

    expect(() => Snapshot.restore(session.id, "missing-snapshot")).toThrow(
      "Snapshot not found: missing-snapshot",
    );
    expect(() => Snapshot.diff(session.id, "missing-snapshot")).toThrow(
      "Snapshot not found: missing-snapshot",
    );
  });
});

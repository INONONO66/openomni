import { sessionTree } from "../helpers/session-tree";
import { Effect, Result } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Inbox } from "@openomni/protocol";
import { SessionHandleStore, Storage } from "../../src/index";

beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:" });
  Result.getOrThrowWith(
    Effect.runSync(
      Effect.result(
        SessionHandleStore.materialize({
          id: "receiver",
          parentId: null,
          role: "resident",
          tools: [],
          system: { preset: "", blocks: [] },
          policyGeneration: 0,
          actionId: "configure",
          at: 1,
        }),
      ),
    ),
    (error) => error,
  );
});
afterEach(() => Storage.reset());

const message: Inbox.Commit = {
  id: "source-message",
  sessionId: "receiver",
  kind: "prompt",
  content: "answer",
  parentActionId: null,
  createdAt: 2,
  origin: { encodingVersion: 1, value: { sourceSessionId: "source", sourceActionId: "terminal" } },
};

test("equivalent received message returns the original durable receipt without another input", () => {
  const first = Result.getOrThrowWith(
    Effect.runSync(Effect.result(SessionHandleStore.commitReceivedMessage(message))),
    (error) => error,
  );
  const revision = SessionHandleStore.row("receiver").revision;
  const duplicate = Result.getOrThrowWith(
    Effect.runSync(
      Effect.result(SessionHandleStore.commitReceivedMessage({ ...message, createdAt: 3 })),
    ),
    (error) => error,
  );
  expect(duplicate).toEqual(first);
  expect(SessionHandleStore.row("receiver").revision).toBe(revision);
  expect(SessionHandleStore.inboxRows("receiver")).toHaveLength(1);
});

test("divergent received message refuses without changing canonical history", () => {
  Result.getOrThrowWith(
    Effect.runSync(Effect.result(SessionHandleStore.commitReceivedMessage(message))),
    (error) => error,
  );
  const before = sessionTree("receiver");
  expect(() =>
    Result.getOrThrowWith(
      Effect.runSync(
        Effect.result(SessionHandleStore.commitReceivedMessage({ ...message, content: "altered" })),
      ),
      (error) => error,
    ),
  ).toThrow(expect.objectContaining({ _tag: "InboxCommitRefused" }));
  expect(sessionTree("receiver")).toEqual(before);
  expect(SessionHandleStore.inboxRows("receiver")[0]?.content).toBe("answer");
});

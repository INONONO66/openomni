import { Effect, Either } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Inbox } from "@openomni/protocol";
import { SessionHandleStore, Storage } from "../../src/index";

beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:" });
  Either.getOrThrowWith(
    Effect.runSync(
      Effect.either(
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
  const first = Either.getOrThrowWith(
    Effect.runSync(Effect.either(SessionHandleStore.commitReceivedMessage(message))),
    (error) => error,
  );
  const revision = SessionHandleStore.row("receiver").revision;
  const duplicate = Either.getOrThrowWith(
    Effect.runSync(
      Effect.either(SessionHandleStore.commitReceivedMessage({ ...message, createdAt: 3 })),
    ),
    (error) => error,
  );
  expect(duplicate).toEqual(first);
  expect(SessionHandleStore.row("receiver").revision).toBe(revision);
  expect(SessionHandleStore.inboxRows("receiver")).toHaveLength(1);
});

test("divergent received message refuses without changing canonical history", () => {
  Either.getOrThrowWith(
    Effect.runSync(Effect.either(SessionHandleStore.commitReceivedMessage(message))),
    (error) => error,
  );
  const before = SessionHandleStore.tree("receiver");
  expect(() =>
    Either.getOrThrowWith(
      Effect.runSync(
        Effect.either(SessionHandleStore.commitReceivedMessage({ ...message, content: "altered" })),
      ),
      (error) => error,
    ),
  ).toThrow(expect.objectContaining({ _tag: "InboxCommitRefused" }));
  expect(SessionHandleStore.tree("receiver")).toEqual(before);
  expect(SessionHandleStore.inboxRows("receiver")[0]?.content).toBe("answer");
});

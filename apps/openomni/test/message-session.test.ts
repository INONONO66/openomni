import { expect, test } from "bun:test";
import { createExecutor } from "@openomni/agent";
import { Inbox, type LedgerSession, type SessionTransition } from "@openomni/protocol";
import { Effect } from "effect";
import {
  createMessageInboxCommit,
  materializeInboxTarget,
  messageMaterialization,
} from "../src/composition/message-session";
import { outboundMessage } from "../src/composition/terminal-message";
import { runnerTestLayer } from "../../../packages/agent/test/helpers/service-layers";
import { runEffect } from "./helpers/effect";
import { testPlane } from "./helpers/ledger";
import { testIds } from "./helpers/test-entropy";

const origin = {
  encodingVersion: 1,
  value: {
    kind: "message",
    messageId: "source-message",
    senderSessionId: "source",
    sourceActionId: "source-action",
  },
} as const;

function inboxCommit(
  id: string,
  createSession?: LedgerSession.Materialize,
  limits?: { readonly fanout: number; readonly depth: number },
): Inbox.Commit {
  return Inbox.Commit.parse({
    id: `${id}:message`,
    sessionId: id,
    kind: "prompt",
    content: "hello",
    origin,
    createdAt: 100,
    parentActionId: null,
    ...(createSession === undefined ? {} : { createSession }),
    ...(limits === undefined ? {} : { limits }),
  });
}

test("inbox target materialization refuses a child beyond its pinned fanout", async () => {
  const plane = testPlane();
  const materialize = messageMaterialization(() => 1, testIds("materialize"));
  try {
    await runEffect(
      materializeInboxTarget(
        plane,
        inboxCommit(
          "parent",
          materialize({
            id: "parent",
            parentId: null,
            role: "resident",
            tools: [],
            preset: "",
            runner: "resident",
            at: 100,
          }),
        ),
        () => 100,
      ),
    );
    await runEffect(
      materializeInboxTarget(
        plane,
        inboxCommit(
          "first-child",
          materialize({
            id: "first-child",
            parentId: "parent",
            role: "worker",
            tools: [],
            preset: "",
            runner: "worker",
            at: 101,
          }),
          { fanout: 1, depth: 2 },
        ),
        () => 101,
      ),
    );
    await expect(
      runEffect(
        materializeInboxTarget(
          plane,
          inboxCommit(
            "second-child",
            materialize({
              id: "second-child",
              parentId: "parent",
              role: "worker",
              tools: [],
              preset: "",
              runner: "worker",
              at: 102,
            }),
            { fanout: 1, depth: 2 },
          ),
          () => 102,
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "AgentFailure",
      operation: "message.commit",
      cause: "child fanout limit exhausted",
    });
    expect(plane.listSessions().map((row) => row.id).sort()).toEqual([
      "first-child",
      "parent",
    ]);
  } finally {
    plane.close();
  }
});

test("entity inbox refuses bytes that do not match the outbound letter", async () => {
  const plane = testPlane();
  const message: SessionTransition.OutboundMessage = {
    messageId: "letter",
    sourceSessionId: "child",
    sourceActionId: "terminal",
    destinationSessionId: "parent",
    requestId: "request",
    replyTo: "request",
    terminal: "completed",
    content: "CHILD_RESULT",
    digest: "digest",
  };
  const executor = await runEffect(
    createExecutor({
      identity: { sessionId: "child", role: "worker", parentActionId: "terminal" },
      ledger: { commit: () => Effect.die(new Error("unused executor commit")) },
    }).pipe(Effect.provide(runnerTestLayer)),
  );
  const unreachable = () => Effect.die(new Error("entity client must not run"));
  const commit = createMessageInboxCommit({
    plane,
    client: () => ({
      Prompt: unreachable,
      Interrupt: unreachable,
      Resume: unreachable,
      RequestResolve: unreachable,
      RequestCancel: unreachable,
      RetryScheduled: unreachable,
      Deadline: unreachable,
      WatchFired: unreachable,
      WatchTimeout: unreachable,
    }),
    clock: () => 100,
  });
  try {
    await expect(
      runEffect(
        commit({
          id: "different-letter",
          sessionId: message.destinationSessionId,
          kind: "prompt",
          content: message.content,
          origin: { encodingVersion: 1, value: message },
          createdAt: 100,
          parentActionId: null,
        }).pipe(
          Effect.provideService(outboundMessage, {
            input: { message, authority: { owner: "runner", fence: 1 } },
            executor,
          }),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "AgentFailure",
      operation: "message.commit",
      cause: "outbound inbox binding mismatch",
    });
    expect(plane.listSessions()).toEqual([]);
  } finally {
    plane.close();
  }
});

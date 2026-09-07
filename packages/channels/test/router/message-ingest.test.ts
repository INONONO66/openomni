import { afterEach, beforeEach, expect, test } from "bun:test";
import { Storage } from "@openomni/ledger";
import type { Gateway, Inbox } from "@openomni/protocol";
import { createGatewayRouter } from "../../src/router";
import { resetStores } from "./_router-fixture";

beforeEach(resetStores);
afterEach(() => Storage.reset());

test("session ingest commits once through the injected inbox without a channel driver", async () => {
  const commits: Inbox.Commit[] = [];
  const router = createGatewayRouter({
    sink: () => undefined,
    inbox: {
      commit: (row) => {
        commits.push(row);
        return { ...row, status: "pending", consumedBy: null, consumedAt: null, ordinal: 1 };
      },
    },
    prepare: () => ({
      target: "child",
      sender: { sessionId: "parent", owner: "process", fence: 1 },
      message: {
        sender: "session",
        senderRole: "resident",
        targetKind: "session",
        targetRole: "worker",
        type: "message",
        parentChild: true,
        fanout: 0,
        depth: 1,
        withinParentDeadline: true,
      },
    }),
    run: async (_sender, request, body) => ({
      terminal: "executed",
      matchedRuleIds: [],
      value: await body({
        action: {
          id: "source",
          sessionId: "parent",
          parentId: null,
          kind: "message",
          intent: { encodingVersion: 1, value: { value: request.intent } },
          effect: { encodingVersion: 1, value: {} },
          irreversible: true,
          ordinal: 1,
          ts: 1,
        },
        revision: 1,
      }),
    }),
  });
  const result: Gateway.IngestResult = await router.ingest(
    { kind: "session", id: "parent" },
    { to: { kind: "session", id: "child" }, type: "message", content: "work" },
  );
  expect(result).toMatchObject({ status: "executed", delivery: { kind: "session" } });
  expect(commits).toHaveLength(1);
  expect(commits[0]).toMatchObject({
    sessionId: "child",
    kind: "prompt",
    content: "work",
    sender: { sessionId: "parent", owner: "process", fence: 1 },
    origin: { value: { kind: "message", senderSessionId: "parent", sourceActionId: "source" } },
  });
});

test.each([
  "content",
  "target",
] as const)("pre transform of %s is applied or refused before inbox commit", async (field) => {
  const commits: Inbox.Commit[] = [];
  const router = createGatewayRouter({
    sink: () => undefined,
    inbox: {
      commit: (row) => {
        commits.push(row);
        return { ...row, status: "pending", consumedBy: null, consumedAt: null, ordinal: 1 };
      },
    },
    prepare: () => ({
      target: "child",
      message: {
        sender: "session",
        senderRole: "resident",
        targetKind: "session",
        type: "message",
        parentChild: true,
        fanout: 0,
        depth: 1,
        withinParentDeadline: true,
      },
    }),
    run: async (_sender, request, body) => {
      const value = request.intent;
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid fixture intent");
      return {
        terminal: "executed",
        matchedRuleIds: [],
        value: await body({
          action: {
            id: "source",
            sessionId: "parent",
            parentId: null,
            kind: "message",
            intent: {
              encodingVersion: 1,
              value: {
                value: {
                  ...value,
                  ...(field === "content"
                    ? { content: "redacted" }
                    : { to: { kind: "session", id: "other" } }),
                },
              },
            },
            effect: { encodingVersion: 1, value: {} },
            irreversible: true,
            ordinal: 1,
            ts: 1,
          },
          revision: 1,
        }),
      };
    },
  });
  const result = router.ingest(
    { kind: "session", id: "parent" },
    {
      to: { kind: "session", id: "child" },
      type: "message",
      content: "secret",
    },
  );
  if (field === "target") {
    await expect(result).rejects.toThrow("message routing transform requires readmission");
    expect(commits).toHaveLength(0);
  } else {
    await result;
    expect(commits[0]?.content).toBe("redacted");
  }
});

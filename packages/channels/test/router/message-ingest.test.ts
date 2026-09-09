import { afterEach, beforeEach, expect, test } from "bun:test";
import { Storage } from "@openomni/ledger";
import { Gateway, type Inbox } from "@openomni/protocol";
import { z } from "zod";
import { createGatewayRouter, type GatewayRouterPorts } from "../../src/router";
import { resetStores } from "./_router-fixture";
import { requestPort } from "../helpers/requests";
import { messageExecutionReceipt } from "../helpers/message-execution";

beforeEach(resetStores);
afterEach(() => Storage.reset());

function recordingRouter(run: GatewayRouterPorts["run"], sender?: Inbox.Commit["sender"]) {
  const commits: Inbox.Commit[] = [];
  const router = createGatewayRouter({
    requests: requestPort(),
    sink: () => undefined,
    inbox: {
      commit: (row) => {
        commits.push(row);
        return { ...row, status: "pending", consumedBy: null, consumedAt: null, ordinal: 1 };
      },
    },
    prepare: () => ({
      target: "child",
      ...(sender === undefined ? {} : { sender }),
      message: {
        sender: "session",
        senderRole: "resident",
        targetKind: "session",
        ...(sender === undefined ? {} : { targetRole: "worker" as const }),
        type: "message",
        parentChild: true,
        fanout: 0,
        depth: 1,
        withinParentDeadline: true,
      },
    }),
    run,
  });
  return { router, commits };
}

test("session ingest commits once through the injected inbox without a channel driver", async () => {
  const { router, commits } = recordingRouter(
    async (_sender, request, body) => ({
      terminal: "executed",
      matchedRuleIds: [],
      value: await body(messageExecutionReceipt("source", "parent", request.intent)),
    }),
    { sessionId: "parent", owner: "process", fence: 1 },
  );
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
  const { router, commits } = recordingRouter(async (_sender, request, body) => {
    const value = Gateway.SendMessage.extend({
      messageId: z.string(),
      sender: Gateway.IngestSender,
    }).parse(request.intent);
    const transformed = {
      ...value,
      ...(field === "content" ? { content: "redacted" } : { to: { kind: "session", id: "other" } }),
    };
    return {
      terminal: "executed",
      matchedRuleIds: [],
      value: await body(messageExecutionReceipt("source", "parent", transformed)),
    };
  });
  const result = router.ingest(
    { kind: "session", id: "parent" },
    { to: { kind: "session", id: "child" }, type: "message", content: "secret" },
  );
  if (field === "target") {
    await expect(result).rejects.toThrow("message routing transform requires readmission");
    expect(commits).toHaveLength(0);
  } else {
    await result;
    expect(commits[0]?.content).toBe("redacted");
  }
});

test("post-execution denial retains the delivery handle and committed effect", async () => {
  const { router, commits } = recordingRouter(async (_sender, request, body) => {
    await body(messageExecutionReceipt("source", "parent", request.intent));
    return { terminal: "blocked_post", matchedRuleIds: ["post-rule"], reason: "post-denial" };
  });
  const result = await router.ingest(
    { kind: "session", id: "parent" },
    { to: { kind: "session", id: "child" }, type: "message", content: "work" },
  );
  expect(result).toMatchObject({
    status: "blocked_post",
    reasonCode: "post-denial",
    handle: { target: "child" },
  });
  expect(commits).toHaveLength(1);
});

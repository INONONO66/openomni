import { Effect } from "effect";
import { channelRequests } from "../helpers/channel-requests";
import { channelTransaction } from "../helpers/channel-transaction";
import { effectFailure } from "../helpers/effect-failure";
import { runEffect } from "../helpers/effect";
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
    requests: channelRequests(requestPort()),
    transaction: channelTransaction,
    sink: () => undefined,
    inbox: {
      commit: (row: Inbox.Commit) => Effect.sync(() => {
        commits.push(row);
        return { ...row, status: "pending" as const, consumedBy: null, consumedAt: null, ordinal: 1 };
      }),
    },
    prepare: () => Effect.succeed({
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

function sendToChild(router: ReturnType<typeof createGatewayRouter>, content: string) {
  return router.ingest(
    { kind: "session", id: "parent" },
    {
      to: { kind: "session", id: "child" },
      type: "message",
      content,
    },
  );
}

test("session ingest commits once through the injected inbox without a channel driver", async () => {
  const { router, commits } = recordingRouter(
    (_sender: Gateway.IngestSender, request: Parameters<GatewayRouterPorts["run"]>[1], body: Parameters<GatewayRouterPorts["run"]>[2]) => Effect.gen(function* () {
      return {
        terminal: "executed" as const,
        matchedRuleIds: [],
        value: yield* body(messageExecutionReceipt("source", "parent", request.intent)),
      };
    }),
    { sessionId: "parent", owner: "process", fence: 1 },
  );
  const result: Gateway.IngestResult = await runEffect(sendToChild(router, "work"));
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
] as const)("pre transform of %s is applied or refused before inbox commit", async (field: "content" | "target") => {
  const { router, commits } = recordingRouter((_sender: Gateway.IngestSender, request: Parameters<GatewayRouterPorts["run"]>[1], body: Parameters<GatewayRouterPorts["run"]>[2]) => Effect.gen(function* () {
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
      value: yield* body(messageExecutionReceipt("source", "parent", transformed)),
    };
  }));
  const result = sendToChild(router, "secret");
  if (field === "target") {
    expect(await effectFailure(result)).toMatchObject({ message: "message routing transform requires readmission" });
    expect(commits).toHaveLength(0);
  } else {
    await runEffect(result);
    expect(commits[0]?.content).toBe("redacted");
  }
});

test("post-execution denial retains the delivery handle and committed effect", async () => {
  const { router, commits } = recordingRouter((_sender: Gateway.IngestSender, request: Parameters<GatewayRouterPorts["run"]>[1], body: Parameters<GatewayRouterPorts["run"]>[2]) => Effect.gen(function* () {
    yield* body(messageExecutionReceipt("source", "parent", request.intent));
    return { terminal: "blocked_post" as const, matchedRuleIds: ["post-rule"], reason: "post-denial" };
  }));
  const result = await runEffect(sendToChild(router, "work"));
  expect(result).toMatchObject({
    status: "blocked_post",
    reasonCode: "post-denial",
    handle: { target: "child" },
  });
  expect(commits).toHaveLength(1);
});

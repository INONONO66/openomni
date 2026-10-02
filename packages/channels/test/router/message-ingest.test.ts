import { ledger, resetLedger } from "../helpers/ledger";
import { Cause, Effect, Exit } from "effect";
import { channelRequests } from "../helpers/channel-requests";
import { channelTransaction } from "../helpers/channel-transaction";
import { effectFailure } from "../helpers/effect-failure";
import { runEffect } from "../helpers/effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Gateway, type Inbox } from "@openomni/protocol";
import { z } from "zod";
import { createGatewayRouter, type GatewayRouterPorts } from "../../src/router";
import { resetStores } from "./_router-fixture";
import { requestPort } from "../helpers/requests";
import { messageExecutionReceipt } from "../helpers/message-execution";
import { recordingInbox } from "./_recording-inbox";

beforeEach(resetStores);
afterEach(() => {
  resetLedger();
});

function testId(prefix: string): () => string {
  const state = { value: 0 };
  return () => { state.value += 1; return `${prefix}-${state.value}`; };
}

function recordingRouter(run: GatewayRouterPorts["run"], sender?: Inbox.Commit["sender"]) {
  const commits: Inbox.Commit[] = [];
  const router = createGatewayRouter({
    requests: channelRequests(requestPort()),
    stores: ledger().stores,
    transaction: channelTransaction,
    now: () => 1,
    id: testId("ingest"),
    sink: () => undefined,
    inbox: recordingInbox(commits),
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
    expect(await effectFailure(result)).toMatchObject({ _tag: "ChannelsFailure", operation: "message.transform" });
    expect(commits).toHaveLength(0);
  } else {
    await runEffect(result);
    expect(commits[0]?.content).toBe("redacted");
  }
});

function executingRun(): GatewayRouterPorts["run"] {
  return (_sender: Gateway.IngestSender, request: Parameters<GatewayRouterPorts["run"]>[1], body: Parameters<GatewayRouterPorts["run"]>[2]) => Effect.gen(function* () {
    return {
      terminal: "executed" as const,
      matchedRuleIds: [],
      value: yield* body(messageExecutionReceipt("source", "parent", request.intent)),
    };
  });
}

test("a receipt recorded for a different session refuses the transform with a typed failure", async () => {
  const { router, commits } = recordingRouter(
    (_sender: Gateway.IngestSender, request: Parameters<GatewayRouterPorts["run"]>[1], body: Parameters<GatewayRouterPorts["run"]>[2]) => Effect.gen(function* () {
      return {
        terminal: "executed" as const,
        matchedRuleIds: [],
        value: yield* body(messageExecutionReceipt("source", "other", request.intent)),
      };
    }),
  );
  expect(await effectFailure(sendToChild(router, "work"))).toMatchObject({
    _tag: "ChannelsFailure",
    operation: "message.transform",
  });
  expect(commits).toEqual([]);
});

test("a receipt whose stored intent is not an object refuses the transform typed", async () => {
  const { router, commits } = recordingRouter(
    (_sender: Gateway.IngestSender, _request: Parameters<GatewayRouterPorts["run"]>[1], body: Parameters<GatewayRouterPorts["run"]>[2]) => Effect.gen(function* () {
      const receipt = messageExecutionReceipt("source", "parent", "ignored");
      const corrupt = {
        ...receipt,
        action: { ...receipt.action, intent: { encodingVersion: 1 as const, value: "bare" } },
      };
      return { terminal: "executed" as const, matchedRuleIds: [], value: yield* body(corrupt) };
    }),
  );
  expect(await effectFailure(sendToChild(router, "work"))).toMatchObject({
    _tag: "ChannelsFailure",
    operation: "message.transform",
  });
  expect(commits).toEqual([]);
});

test("a receipt whose stored intent value is not an object refuses the transform typed", async () => {
  const { router, commits } = recordingRouter(
    (_sender: Gateway.IngestSender, _request: Parameters<GatewayRouterPorts["run"]>[1], body: Parameters<GatewayRouterPorts["run"]>[2]) => Effect.gen(function* () {
      return {
        terminal: "executed" as const,
        matchedRuleIds: [],
        value: yield* body(messageExecutionReceipt("source", "parent", "bare")),
      };
    }),
  );
  expect(await effectFailure(sendToChild(router, "work"))).toMatchObject({
    _tag: "ChannelsFailure",
    operation: "message.transform",
  });
  expect(commits).toEqual([]);
});

test("a transform that replaces content with non-text refuses typed", async () => {
  const { router, commits } = recordingRouter(
    (_sender: Gateway.IngestSender, request: Parameters<GatewayRouterPorts["run"]>[1], body: Parameters<GatewayRouterPorts["run"]>[2]) => Effect.gen(function* () {
      const value = Gateway.SendMessage.extend({
        messageId: z.string(),
        sender: Gateway.IngestSender,
      }).parse(request.intent);
      return {
        terminal: "executed" as const,
        matchedRuleIds: [],
        value: yield* body(messageExecutionReceipt("source", "parent", { ...value, content: 7 })),
      };
    }),
  );
  expect(await effectFailure(sendToChild(router, "secret"))).toMatchObject({
    _tag: "ChannelsFailure",
    operation: "message.transform",
  });
  expect(commits).toEqual([]);
});

test("an actor send without configured messaging dies with the channels invariant", async () => {
  const { router, commits } = recordingRouter(executingRun());
  const exit = await runEffect(Effect.exit(router.ingest(
    { kind: "session", id: "parent" },
    { to: { kind: "actor", actorId: "actor:missing" }, type: "message", content: "hi" },
  )));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) return;
  expect(Cause.hasDies(exit.cause)).toBe(true);
  expect(Cause.squash(exit.cause)).toMatchObject({
    _tag: "ChannelsFailure",
    operation: "message.actor_send",
  });
  expect(commits).toEqual([]);
});

test("a session send prepared without a session projection dies with the channels invariant", async () => {
  const commits: Inbox.Commit[] = [];
  const router = createGatewayRouter({
    requests: channelRequests(requestPort()),
    stores: ledger().stores,
    transaction: channelTransaction,
    now: () => 1,
    id: testId("projection"),
    sink: () => undefined,
    inbox: recordingInbox(commits),
    prepare: () => Effect.succeed({
      target: "child",
      message: { sender: "external" as const, eventIdUnique: true },
    }),
    run: executingRun(),
  });
  const exit = await runEffect(Effect.exit(sendToChild(router, "work")));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) return;
  expect(Cause.hasDies(exit.cause)).toBe(true);
  expect(Cause.squash(exit.cause)).toMatchObject({
    _tag: "ChannelsFailure",
    operation: "message.project",
  });
  expect(commits).toEqual([]);
});

test.each(["interrupted", "outcome_unknown"] as const)("%s preserves the handle without committing an inbox", async (terminal: "interrupted" | "outcome_unknown") => {
  const { router, commits } = recordingRouter(() => Effect.succeed({
    terminal, reason: "execution_stopped", matchedRuleIds: [],
  }));
  const result = await runEffect(sendToChild(router, "work"));
  expect(result).toMatchObject({
    status: "blocked_post", reasonCode: "execution_stopped", handle: { target: "child" },
  });
  expect(commits).toEqual([]);
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

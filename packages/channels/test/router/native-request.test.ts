import { channelRequests } from "../helpers/channel-requests";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runEffect } from "../helpers/effect";
import { Effect } from "effect";
import { effectFailure } from "../helpers/effect-failure";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { canonicalDigest, type SessionTransition } from "@openomni/protocol";
import { answerNativeRequest } from "../../src/router/request/native";
import { openRequest, requestPort } from "../helpers/requests";
import { makeRouter } from "./_router-fixture";

beforeEach(() => Storage.initialize({ dbPath: ":memory:" }));
afterEach(() => Storage.reset());
const sender = { kind: "session", id: "child" } as const;
function outbound(
  overrides: Partial<SessionTransition.OutboundMessage> = {},
): SessionTransition.OutboundMessage {
  const payload = {
    messageId: "terminal:reply",
    sourceSessionId: "child",
    sourceActionId: "terminal",
    destinationSessionId: "request-owner",
    requestId: "original",
    replyTo: "binding",
    terminal: "completed" as const,
    content: "answer",
    ...overrides,
  };
  return { ...payload, digest: canonicalDigest(payload) };
}

test("native reply reaches the canonical receiving inbox once and retains its original binding", async () => {
  await runEffect(await openRequest("original", {
    expectedResponders: [sender.id],
    correlation: {},
    deadline: 100,
  }));
  const received: string[] = [];
  const port = channelRequests(requestPort(
    () => 2,
    (ids: readonly string[]) => received.push(...ids),
  ));
  const message = outbound();
  const gateway = makeRouter({
    clock: () => 2,
    requests: port,
    prepare: () => Effect.succeed({
      target: message.destinationSessionId,
      origin: message,
      message: {
        sender: "session",
        senderRole: "worker",
        targetKind: "session",
        type: "message",
        parentChild: true,
        fanout: 0,
        depth: 1,
        withinParentDeadline: true,
      },
    }),
    inbox: {
      commit: () => {
        throw new Error("native answer bypassed request admission");
      },
    },
  });
  const deliver = () =>
    gateway.ingest(sender, {
      to: { kind: "session", id: message.destinationSessionId },
      type: "message",
      content: message.content,
    });
  expect(await runEffect(deliver())).toMatchObject({ status: "executed", delivery: { kind: "session" } });
  expect(SessionHandleStore.requestById("original")?.state).toBe("resolved");
  const before = SessionHandleStore.tree("request-owner");
  expect(await runEffect(deliver())).toMatchObject({ status: "executed", delivery: { kind: "session" } });
  expect(SessionHandleStore.tree("request-owner")).toEqual(before);
  expect(received).toEqual(["request-owner"]);
  expect(SessionHandleStore.inboxRows("request-owner")).toHaveLength(1);
  expect(SessionHandleStore.inboxRows("request-owner")[0]?.origin.value).toEqual(message);
});

test("native reply rejects an altered authenticated sender, content, or destination binding", async () => {
  await runEffect(await openRequest("original", { expectedResponders: [sender.id], correlation: {} }));
  const port = channelRequests(requestPort());
  const before = SessionHandleStore.tree("request-owner");
  expect(await effectFailure(answerNativeRequest(port, { kind: "session", id: "stranger" }, outbound(), "answer", 2))).toBeInstanceOf(Error);
  expect(await effectFailure(answerNativeRequest(port, sender, outbound(), "altered", 2))).toBeInstanceOf(Error);
  expect(await effectFailure(answerNativeRequest(port, sender, outbound({ destinationSessionId: "other" }), "answer", 2))).toBeInstanceOf(Error);
  expect(await effectFailure(answerNativeRequest(port, sender, outbound({ requestId: "missing" }), "answer", 2))).toBeInstanceOf(Error);
  expect(await runEffect(answerNativeRequest(port, sender, undefined, "ordinary", 2))).toBe(false);
  expect(SessionHandleStore.tree("request-owner")).toEqual(before);
});

test("a late native answer records the timeout winner without manufacturing new conversational input", async () => {
  await runEffect(await openRequest("original", { expectedResponders: [sender.id], correlation: {}, deadline: 2 }));
  expect(
    await runEffect(answerNativeRequest(
      channelRequests(requestPort(() => 2)),
      sender,
      outbound(),
      "answer",
      2,
    )),
  ).toBe(true);
  expect(SessionHandleStore.requestById("original")?.state).toBe("expired");
  expect(SessionHandleStore.inboxRows("request-owner")).toEqual([]);
});

import { expect, test } from "bun:test";
import { assertNoLegacyRequestStores } from "./helpers/storage-evidence";
import { Bus } from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import { L0Observation } from "@openomni/protocol";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { bounded } from "./helpers/protected-dispatch";
import { nextFrame } from "./helpers/ws";

const suite = residentSuite();

test("real external WebSocket reply wakes its original idle request owner without legacy writes", async () => {
  let sent = false;
  let received = 0;
  const waiting = Promise.withResolvers<string>();
  const completed = Promise.withResolvers<string>();
  suite.defer(
    Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
      if (event.kind !== "turn") return;
      const terminal = SessionHandleStore.turnTerminal(
        SessionHandleStore.tree(event.sessionId).find((action) => action.id === event.id),
      );
      if (terminal?.text === "WAITING_EXTERNAL_SENTINEL") waiting.resolve(event.sessionId);
      if (terminal?.text === "DONE_EXTERNAL_SENTINEL") completed.resolve(event.sessionId);
    }),
  );
  const config = suite.config("request-channel-", {
    wsToken: "token",
    actors: [
      { actorId: "owner", externalId: "owner", kind: "human", trustTier: "owner" },
      { actorId: "peer", externalId: "peer", kind: "ai_agent", trustTier: "assigned_worker" },
    ],
    socialBudgets: [
      { id: "peer-budget", targetActorId: "peer", maxPerWindow: 5, windowMs: 1000, cooldownMs: 0 },
    ],
  });
  const app = await suite.boot({
    config,
    sessionRuntime: { clock: () => 100 },
    llm: {
      resolveModel: fakeProviderModel,
      run: async (input, sink) => {
        if (!sent) {
          const result = requestToolStep(input, sink, {
            id: "external-request",
            tool: "send_message",
            input: {
              to: { kind: "contact", id: "peer" },
              message: "QUESTION_SENTINEL",
              deadline_ms: 900,
            },
          });
          if (result === undefined) return { type: "stop" };
          expect(result.isError).not.toBe(true);
          sent = true;
        }
        const hasAnswer = JSON.stringify(input.messages).includes("EXTERNAL_ANSWER_SENTINEL");
        if (hasAnswer) received += 1;
        sink.onMessage(
          assistantMessage(input, {
            text: hasAnswer ? "DONE_EXTERNAL_SENTINEL" : "WAITING_EXTERNAL_SENTINEL",
          }),
        );
        return { type: "stop" };
      },
    },
  });
  const owner = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, [
    "auth",
    "token",
  ]);
  const peer = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=peer`, [
    "auth",
    "token",
  ]);
  const question = nextFrame(peer, (frame) => frame.type === "message");
  const admitted = nextFrame(owner, (frame) => frame.type === "receipt");
  owner.send(JSON.stringify({ text: "START_EXTERNAL_SENTINEL", eventId: "owner-input" }));
  const [delivery, source] = await Promise.all([question, bounded(waiting.promise), admitted]);
  expect(delivery.text).toBe("QUESTION_SENTINEL");
  expect(typeof delivery.messageId).toBe("string");
  expect(SessionHandleStore.row(source).state).toBe("idle");
  const receipt = nextFrame(peer, (frame) => frame.type === "receipt" || frame.type === "error");
  peer.send(
    JSON.stringify({
      text: "EXTERNAL_ANSWER_SENTINEL",
      replyToId: delivery.messageId,
      eventId: "peer-answer",
    }),
  );
  expect(await receipt).toMatchObject({ type: "receipt", status: "accepted" });
  expect(await bounded(completed.promise)).toBe(source);
  expect(received).toBe(1);
  const request = SessionHandleStore.requestRows(source)[0];
  expect(request?.state).toBe("resolved");
  expect(request?.replies).toHaveLength(1);
  expect(
    SessionHandleStore.inboxRows(source).filter((row) => row.id === request?.replies[0]?.replyId),
  ).toHaveLength(1);
  assertNoLegacyRequestStores(config.dbPath);
});

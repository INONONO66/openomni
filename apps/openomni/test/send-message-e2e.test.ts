import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Bus } from "@openomni/agent";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { L0Observation, SessionTransition, SessionTurn } from "@openomni/protocol";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextFrame } from "./helpers/ws";

const suite = residentSuite();

test.each([
  "?actor=owner",
  "",
])("startOpenOmni delivers the final response through an actor send for connection %s", async (query) => {
  const app = await suite.boot({
    config: suite.config("message-e2e-", {
      wsToken: "token",
      actors: [
        {
          actorId: "known-owner",
          externalId: "owner",
          kind: "human",
          trustTier: "owner",
          displayName: "Owner",
        },
      ],
      socialBudgets: [
        {
          id: "owner-budget",
          targetActorId: "known-owner",
          maxPerWindow: 10,
          windowMs: 1000,
          cooldownMs: 0,
        },
      ],
    }),
    llm: {
      resolveModel: fakeProviderModel,
      run: async (input, sink) => {
        sink.onMessage(assistantMessage(input, { text: "FINAL_SENTINEL" }));
        return { type: "stop" };
      },
    },
  });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws${query}`, ["auth", "token"]);
  const receipt = nextFrame(ws, (frame) => frame.type === "receipt");
  const final = nextFrame(ws, (frame) => frame.type === "message");
  ws.send(JSON.stringify({ text: "start" }));
  expect(await receipt).toMatchObject({ type: "receipt", status: "accepted" });
  expect(await final).toMatchObject({ type: "message", text: "FINAL_SENTINEL" });
  const actions = SessionHandleStore.listRows().flatMap((row) => SessionHandleStore.tree(row.id));
  expect(actions.some((action) => action.kind === "message")).toBe(true);
});

test("a child session terminal commits exactly one parent reply with the original reply binding", async () => {
  let commissioned = false;
  const reply = Promise.withResolvers<void>();
  let consumed = false;
  let acknowledged = false;
  const timer = setTimeout(
    () => reply.reject(new Error("receiving executor or source acknowledgement missing")),
    5000,
  );
  const completed = reply.promise.then(
    () => ({ ok: true }),
    (error: Error) => ({ ok: false, error }),
  );
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    const action = SessionHandleStore.tree(event.sessionId).find(
      (candidate) => candidate.id === event.id,
    );
    if (action === undefined) return;
    if (action.kind === "inbox.deliver") {
      const delivery = SessionTurn.Delivery.safeParse(action.effect.value);
      if (delivery.success && delivery.data.content.includes("CHILD_SENTINEL")) consumed = true;
    }
    const effect = action.effect.value;
    if (
      action.kind === "outbound" &&
      effect !== null &&
      typeof effect === "object" &&
      !Array.isArray(effect)
    ) {
      const outbound = SessionTransition.Outbound.safeParse(effect.outbound);
      if (
        outbound.success &&
        outbound.data.state === "delivered" &&
        outbound.data.message.content.includes("CHILD_SENTINEL")
      )
        acknowledged = true;
    }
    if (consumed && acknowledged) reply.resolve();
  });
  suite.defer(() => {
    clearTimeout(timer);
    unsubscribe();
  });
  const config = suite.config("message-child-", { wsToken: "token" });
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: async (input, sink) => {
        if (SessionHandleStore.row(input.trace.sessionId).role === "worker") {
          sink.onMessage(assistantMessage(input, { text: "CHILD_SENTINEL" }));
          return { type: "stop" };
        }
        if (!commissioned) {
          const output = requestToolStep(input, sink, {
            id: "commission",
            tool: "sendMessage",
            input: {
              to: { kind: "new_session", role: "worker", runner: "native", parent: "me" },
              type: "message",
              content: "child request",
              replyTo: "original-binding",
            },
          });
          if (output === undefined) return { type: "stop" };
          expect(output.isError).not.toBe(true);
          commissioned = true;
        }
        sink.onMessage(assistantMessage(input, { text: "PARENT_SENTINEL" }));
        return { type: "stop" };
      },
    },
  });
  await app.gateway.ingest(
    { kind: "external", surface: "ws", externalId: "owner" },
    {
      eventId: "initial",
      surface: "ws",
      channelId: "owner",
      addressees: [],
      dm: true,
      payload: {},
      render: "start",
    },
  );
  expect(await completed).toEqual({ ok: true });
  const child = SessionHandleStore.listRows().find((row) => row.role === "worker");
  if (child?.parentId === null || child?.parentId === undefined)
    throw new Error("child parent missing");
  const rows = SessionHandleStore.inboxRows(child.parentId).filter((row) => {
    const value = row.origin.value;
    return SessionTransition.OutboundMessage.safeParse(value).success;
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.origin.value).toMatchObject({
    sourceSessionId: child.id,
    terminal: "completed",
    replyTo: "original-binding",
  });
  expect(rows[0]?.content).toContain("CHILD_SENTINEL");
  const outbound = SessionHandleStore.outboundRows(child.id)[0];
  const receipt = SessionHandleStore.tree(child.parentId).find(
    (action) => action.id === outbound?.destinationReceipt?.id,
  );
  expect(receipt).toMatchObject({
    kind: "reply",
    effect: { value: { answer: { inputId: rows[0]?.id, outbound: rows[0]?.origin.value } } },
  });
  expect(rows[0]?.status).toBe("consumed");
  expect("wait" in Storage.get()).toBe(false);
  expect("approval" in Storage.get()).toBe(false);
  using db = new Database(config.dbPath, { readonly: true });
  expect(
    db
      .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('wait','approval')")
      .all(),
  ).toEqual([]);
});

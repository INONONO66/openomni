import { sessionTree } from "../../../packages/agent/test/store/helpers/session-tree";
import { Effect } from "effect";
import { expect, spyOn, test } from "bun:test";
import { assertNoLegacyRequestStores } from "./helpers/storage-evidence";
import { ownerStart } from "./helpers/owner-start";
import { Bus, newTraceId } from "./helpers/bus";
import { L0Observation, SessionTransition, SessionTurn } from "@openomni/protocol";
import { sessionFilePath, type AppLedgerPlane } from "../src/composition/cluster-runtime";
import { planeOf } from "./helpers/ledger";
import { assistantMessage, commissionInput, requestToolStep } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { receivedMessages } from "./helpers/received-messages";
import { nextFrame } from "./helpers/ws";
import { nextResidentTurn } from "./helpers/resident-turn";

/** expect.objectContaining, typed as the value the partial shape matches. */
function containing<T extends object>(shape: Partial<T> & object): T {
  return expect.objectContaining(shape) as T;
}

const suite = residentSuite();

test.each([
  "?actor=owner",
  "",
])("an external turn never dispatches an unsolicited reply for connection %s", async (query) => {
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
      run: (input, sink) => Effect.sync(() => {
        sink.onMessage(assistantMessage(input, { text: "FINAL_SENTINEL" }));
        return { type: "stop" };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws${query}`, ["auth", "token"]);
  const ingest = spyOn(app.gateway, "ingest");
  suite.defer(() => ingest.mockRestore());
  const receipt = nextFrame(ws, (frame) => frame.type === "receipt");
  const terminal = nextResidentTurn(plane);
  ws.send(JSON.stringify({ eventId: newTraceId(), text: "start" }));
  expect(await receipt).toMatchObject({ type: "receipt", status: "accepted" });
  expect((await terminal).text).toBe("FINAL_SENTINEL");
  expect(ingest.mock.calls.filter(([sender]) => sender.kind === "session")).toEqual([]);
  const actions = plane
    .listSessions()
    .flatMap((row) => sessionTree(row.id, plane.sessionStore(row.id).actions));
  expect(actions.filter((action) => action.kind === "message" && (action.effect.value as { outbound?: unknown } | null)?.outbound !== undefined)).toEqual([]);
});

test("an explicit model send_message routes through MessagePort.ingest to the external surface", async () => {
  const app = await suite.boot({
    config: suite.config("explicit-message-", {
      wsToken: "token",
      actors: [{ actorId: "owner", externalId: "owner", kind: "human", trustTier: "owner" }],
      socialBudgets: [{ id: "owner-budget", targetActorId: "owner", maxPerWindow: 1, windowMs: 1000, cooldownMs: 0 }],
    }),
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink) => Effect.sync(() => {
        const result = requestToolStep(input, sink, {
          id: "explicit-send", tool: "send_message",
          input: { to: { kind: "contact", id: "owner" }, message: "EXPLICIT_SENTINEL" },
        });
        if (result === undefined) return { type: "stop" };
        expect(result.isError).not.toBe(true);
        sink.onMessage(assistantMessage(input, { text: "LOCAL_ONLY_SENTINEL" }));
        return { type: "stop" };
      }),
    },
  });
  const plane = await planeOf(app.runtime);
  const ingest = spyOn(app.gateway, "ingest");
  suite.defer(() => ingest.mockRestore());
  type IngestCall = Parameters<typeof app.gateway.ingest>;
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, ["auth", "token"]);
  const delivered = nextFrame(ws, (frame) => frame.type === "message");
  const terminal = nextResidentTurn(plane);
  ws.send(JSON.stringify({ eventId: newTraceId(), text: "send explicitly" }));
  expect(await delivered).toMatchObject({ text: "EXPLICIT_SENTINEL" });
  expect((await terminal).text).toBe("LOCAL_ONLY_SENTINEL");
  expect(ingest.mock.calls.filter(([sender]) => sender.kind === "session")).toEqual([
    [containing<IngestCall[0]>({ kind: "session" }), containing<IngestCall[1]>({
      to: { kind: "actor", actorId: "owner" }, content: "EXPLICIT_SENTINEL",
    })],
  ]);
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
  const planeRef: { current: AppLedgerPlane | undefined } = { current: undefined };
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    const eventPlane = planeRef.current;
    if (eventPlane === undefined) return;
    const action = sessionTree(event.sessionId, eventPlane.sessionStore(event.sessionId).actions).find(
      (candidate) => candidate.id === event.id,
    );
    if (action === undefined) return;
    if (action.kind === "prompt" || action.kind === "signal") {
      const delivery = SessionTurn.Delivery.safeParse(action.effect.value);
      if (delivery.success && delivery.data.content.includes("CHILD_SENTINEL")) consumed = true;
    }
    const effect = action.effect.value;
    if (
      action.kind === "message" &&
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
      run: (input, sink) => Effect.sync(() => {
        const runPlane = planeRef.current;
        if (runPlane === undefined) throw new Error("plane not resolved before model run");
        if (runPlane.openKernel(input.trace.sessionId).row(input.trace.sessionId).role === "worker") {
          sink.onMessage(assistantMessage(input, { text: "CHILD_SENTINEL" }));
          return { type: "stop" };
        }
        if (!commissioned) {
          const output = requestToolStep(input, sink, {
            id: "commission",
            tool: "send_message",
            input: commissionInput({ message: "child request", reply_to: "original-binding" }),
          });
          if (output === undefined) return { type: "stop" };
          expect(output.isError).toBeUndefined();
          commissioned = true;
        }
        sink.onMessage(assistantMessage(input, { text: "PARENT_SENTINEL" }));
        return { type: "stop" };
      }),
    },
  });
  planeRef.current = await planeOf(app.runtime);
  const plane = planeRef.current;
  await ownerStart(app, "initial");
  expect(await completed).toEqual({ ok: true });
  const child = plane.listSessions().find((row) => row.role === "worker");
  if (child?.parentId === null || child?.parentId === undefined)
    throw new Error("child parent missing");
  const parentTree = sessionTree(child.parentId, plane.sessionStore(child.parentId).actions);
  const rows = receivedMessages(plane, child.parentId)
    .filter((row) => SessionTransition.OutboundMessage.safeParse(row.origin.value).success);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.origin.value).toMatchObject({
    sourceSessionId: child.id,
    terminal: "completed",
    replyTo: "original-binding",
  });
  expect(rows[0]?.content).toContain("CHILD_SENTINEL");
  const outbound = plane.openKernel(child.id).outboundRows(child.id)[0];
  const receipt = parentTree.find(
    (action) => action.id === outbound?.destinationReceipt?.id,
  );
  expect(receipt).toMatchObject({
    kind: "reply",
    effect: { value: { answer: { inputId: rows[0]?.id, outbound: rows[0]?.origin.value } } },
  });
  // W5.2 consumed = no longer pending in the parent's kernel inbox.
  expect(
    plane
      .openKernel(child.parentId)
      .pendingMessages(child.parentId)
      .some((item) => item.id === rows[0]?.id),
  ).toBe(false);
  const sessionsDir = config.sessionsDir;
  if (sessionsDir === undefined) throw new Error("suite config is missing sessionsDir");
  assertNoLegacyRequestStores(sessionFilePath(sessionsDir, child.parentId));
});

import { expect, test } from "bun:test";
import { Bus, createSessionRequests } from "@openomni/agent";
import { SessionHandleStore, SqliteStorageAdapter, Storage } from "@openomni/ledger";
import { canonicalDigest, Gateway, L0Observation } from "@openomni/protocol";
import type { RunInput, Sink } from "@openomni/llm";
import { assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";

const suite = residentSuite();

test("the shipped startup alarm owner fires exactly at the deadline and never twice after restart", async () => {
  const config = suite.config("message-alarm-boot-");
  let now = 10;
  let calls = 0;
  const options = {
    config,
    sessionRuntime: { clock: () => now },
    llm: {
      resolveModel: fakeProviderModel,
      run: async (input: RunInput, sink: Sink) => {
        calls += 1;
        sink.onMessage(assistantMessage(input, { text: "ALARM_SENTINEL" }));
        return { type: "stop" as const };
      },
    },
  };
  const app = await suite.boot(options);
  const terminal = Promise.withResolvers<void>();
  const timer = setTimeout(() => terminal.reject(new Error("initial terminal missing")), 5000);
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "turn") return;
    const action = SessionHandleStore.tree(event.sessionId).find((row) => row.id === event.id);
    if (action !== undefined && SessionHandleStore.turnTerminal(action) !== undefined)
      terminal.resolve();
  });
  let id: string;
  try {
    const receipt = await app.gateway.ingest(
      { kind: "external", surface: "ws", externalId: "owner" },
      {
        eventId: "seed",
        surface: "ws",
        channelId: "owner",
        dm: true,
        addressees: [],
        payload: "seed",
        render: "seed",
      },
    );
    if (receipt.status !== "executed") throw new Error("seed refused");
    id = receipt.handle.target;
    await terminal.promise;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  await app.stop();
  Storage.configure(new SqliteStorageAdapter(config.dbPath));
  const row = SessionHandleStore.row(id);
  expect(
    Storage.get().actions?.append(
      {
        id: "alarm-source",
        sessionId: id,
        parentId: null,
        kind: "message",
        intent: {
          encodingVersion: 1,
          value: {
            phase: "intent",
            value: { messageId: "deadline-request" },
            effectHash: canonicalDigest({}),
          },
        },
        effect: { encodingVersion: 1, value: { state: "open" } },
        irreversible: true,
        ts: now,
      },
      row.revision,
    ),
  ).toBeDefined();
  await createSessionRequests({ observations: Bus, clock: () => now }).open({
    requestId: "alarm-source",
    sessionId: id,
    deadline: 100,
    at: now,
    expectedResponders: ["peer"],
    correlation: {},
    allowedActions: ["report_result"],
    resolution: "first",
    threshold: 1,
  });
  Storage.reset();
  calls = 0;
  now = 99;
  const early = await suite.boot(options);
  expect(SessionHandleStore.requestById("alarm-source")?.state).toBe("open");
  expect(calls).toBe(0);
  await early.stop();
  now = 100;
  const observations: Gateway.MessageObservation[] = [];
  const stop = Bus.subscribe(Gateway.MessageObserved, (observation) => {
    if (observation.kind === "message.timed_out") {
      expect(SessionHandleStore.requestById("alarm-source")?.state).toBe("expired");
      observations.push(observation);
    }
  });
  suite.defer(stop);
  const due = await suite.boot(options);
  expect(calls).toBe(0);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    kind: "message.timed_out",
    messageId: "deadline-request",
    waitedMs: 90,
    sessionId: id,
  });
  expect(SessionHandleStore.requestById("alarm-source")?.state).toBe("expired");
  expect(SessionHandleStore.inboxRows(id)).toHaveLength(1);
  await due.stop();
  await suite.boot(options);
  expect(calls).toBe(0);
  expect(observations).toHaveLength(1);
  expect(SessionHandleStore.inboxRows(id)).toHaveLength(1);
});

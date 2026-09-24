import { sessionTree } from "../helpers/session-tree";
import { expect, spyOn, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import {
  type Alarm,
  canonicalDigest,
  LedgerAction,
  type LedgerSession,
  L0Observation,
} from "@openomni/protocol";
import { LedgerLive, LedgerWrites, SqliteStorageAdapter } from "../../src";

function fixture() {
  const observations: L0Observation.ActionCommitted[] = [];
  const storage = new SqliteStorageAdapter(":memory:", {
    publish(event, payload) {
      if (event.name === L0Observation.ActionCommittedEvent.name)
        observations.push(L0Observation.ActionCommitted.parse(payload));
    },
  });
  Effect.runSync(
    storage.sessions.create({
      id: "session",
      parentId: null,
      role: "resident",
      state: "idle",
      revision: 0,
      leaseOwner: null,
      leaseFence: 0,
      leaseExpiresAt: null,
      toolsGeneration: 0,
      systemHash: "",
      policyGeneration: 0,
    }),
  );
  const input: LedgerSession.Commit = {
    sessionId: "session",
    owner: "writer",
    fence: 1,
    now: 2,
    expectedRevision: 0,
    actions: [
      {
        id: "action",
        sessionId: "session",
        parentId: null,
        kind: "turn",
        intent: { encodingVersion: 1, value: { phase: "intent" } },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
        irreversible: true,
        ts: 2,
      },
    ],
    consumeInboxIds: [],
    state: "running",
    releaseLease: false,
  };
  return { storage, observations, input, [Symbol.dispose]: () => storage.close() };
}

function acquire(storage: SqliteStorageAdapter) {
  return Effect.runSync(
    storage.sessions.acquireLease({
      sessionId: "session",
      owner: "writer",
      expectedFence: 0,
      now: 1,
      expiresAt: 100,
    }),
  );
}

const fire: Alarm.Fire = {
  id: "alarm",
  epoch: 1,
  fence: 0,
  sourceKey: "timer",
  at: 10,
  content: "due",
  terminal: true,
};

test("commit refusal is tagged with revision and fence and leaves no partial SQL or observation", () => {
  using f = fixture();
  acquire(f.storage);
  const before = f.storage.sessions.get("session");
  const refused = Effect.runSync(
    Effect.flip(f.storage.sessions.commit({ ...f.input, expectedRevision: 1 })),
  );
  expect(refused).toMatchObject({
    _tag: "CommitRefused",
    sessionId: "session",
    reason: "revision",
    expectedRevision: 1,
    currentRevision: 0,
    fence: 1,
    currentFence: 1,
  });
  expect(f.storage.sessions.get("session")).toEqual(before);
  expect(sessionTree("session", f.storage.actions)).toEqual([]);
  expect(f.observations).toEqual([]);
});

test("a late commit CAS refusal rolls back actions already appended in the same transaction", () => {
  using f = fixture();
  acquire(f.storage);
  const before = f.storage.sessions.get("session");
  f.storage
    .testDatabase()
    .run(
      "CREATE TRIGGER refuse_state BEFORE UPDATE OF state ON session BEGIN SELECT RAISE(IGNORE); END",
    );
  expect(Effect.runSync(Effect.flip(f.storage.sessions.commit(f.input)))).toMatchObject({
    _tag: "CommitRefused",
    reason: "fence",
    currentFence: 1,
    currentRevision: 0,
  });
  expect(f.storage.sessions.get("session")).toEqual(before);
  expect(sessionTree("session", f.storage.actions)).toEqual([]);
  expect(f.observations).toEqual([]);
});

test("lease contention and SQL CAS loss preserve holder and fence in typed refusals", () => {
  using f = fixture();
  acquire(f.storage);
  expect(
    Effect.runSync(
      Effect.flip(
        f.storage.sessions.acquireLease({
          sessionId: "session",
          owner: "contender",
          expectedFence: 1,
          now: 2,
          expiresAt: 101,
        }),
      ),
    ),
  ).toMatchObject({
    _tag: "LeaseRefused",
    reason: "held",
    holder: "writer",
    fence: 1,
    expiresAt: 100,
  });
  f.storage
    .testDatabase()
    .run(
      "CREATE TRIGGER refuse_fence BEFORE UPDATE OF lease_fence ON session BEGIN SELECT RAISE(IGNORE); END",
    );
  expect(
    Effect.runSync(
      Effect.flip(
        f.storage.sessions.acquireLease({
          sessionId: "session",
          owner: "contender",
          expectedFence: 1,
          now: 100,
          expiresAt: 200,
        }),
      ),
    ),
  ).toMatchObject({
    _tag: "LeaseRefused",
    reason: "stale",
    holder: "writer",
    fence: 1,
    expiresAt: 100,
  });
  expect(f.storage.sessions.get("session")).toMatchObject({ leaseOwner: "writer", leaseFence: 1 });
});

test("expired renewal and stale commit fail in the typed channel", () => {
  using f = fixture();
  acquire(f.storage);
  expect(
    Effect.runSync(
      Effect.flip(
        f.storage.sessions.renewLease({
          sessionId: "session",
          owner: "writer",
          fence: 1,
          now: 100,
          expiresAt: 200,
        }),
      ),
    ),
  ).toMatchObject({ _tag: "LeaseRefused", reason: "stale", holder: "writer", fence: 1 });
  Effect.runSync(
    f.storage.sessions.acquireLease({
      sessionId: "session",
      owner: "successor",
      expectedFence: 1,
      now: 100,
      expiresAt: 200,
    }),
  );
  expect(
    Effect.runSync(Effect.flip(f.storage.sessions.commit({ ...f.input, now: 101 }))),
  ).toMatchObject({
    _tag: "CommitRefused",
    reason: "fence",
    fence: 1,
    currentFence: 2,
  });
  expect(sessionTree("session", f.storage.actions)).toEqual([]);
});

test("alarm fire on a missing row is a typed refusal", () => {
  using f = fixture();
  expect(Effect.runSync(Effect.flip(f.storage.alarms.fire(fire)))).toMatchObject({
    _tag: "AlarmRefused",
    alarmId: "alarm",
    operation: "fire",
    reason: "missing",
  });
  expect(f.observations).toEqual([]);
});

test("alarm prompt append refusal rolls back the fired action without publishing", () => {
  using f = fixture();
  Effect.runSync(
    f.storage.alarms.arm({ id: "alarm", sessionId: "session", kind: "at", fireAt: 10 }),
  );
  const collision = canonicalDigest(["alarm.inbox", "alarm", 1, "timer"]);
  f.storage.actions.append({ ...LedgerAction.Append.parse(f.input.actions[0]), id: collision }, 1);
  const before = sessionTree("session", f.storage.actions);
  const observed = [...f.observations];
  expect(Effect.runSync(Effect.flip(f.storage.alarms.fire(fire)))).toMatchObject({
    _tag: "AlarmRefused",
    alarmId: "alarm",
    operation: "fire",
    reason: "prompt",
  });
  expect(sessionTree("session", f.storage.actions)).toEqual(before);
  expect(f.storage.inbox.list("session")).toEqual([]);
  expect(f.storage.alarms.get("alarm")?.status).toBe("armed");
  expect(f.observations).toEqual(observed);
});

test("SQLite failure rolls back alarm action prompt and inbox and retains string diagnostics", () => {
  using f = fixture();
  Effect.runSync(
    f.storage.alarms.arm({ id: "alarm", sessionId: "session", kind: "at", fireAt: 10 }),
  );
  f.storage
    .testDatabase()
    .run(
      "CREATE TRIGGER refuse_inbox BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
  const failure = Effect.runSync(Effect.flip(f.storage.alarms.fire(fire)));
  expect(failure).toMatchObject({ _tag: "ForeignFailure", operation: "alarm.fire" });
  if (failure._tag !== "ForeignFailure") throw failure;
  expect(typeof failure.cause).toBe("string");
  expect(failure.cause.length).toBeGreaterThan(0);
  expect(sessionTree("session", f.storage.actions).map((action) => action.kind)).toEqual(["alarm.arm"]);
  expect(f.storage.inbox.list("session")).toEqual([]);
  expect(f.storage.alarms.get("alarm")?.status).toBe("armed");
  expect(f.observations.map((event) => event.kind)).toEqual(["alarm.arm"]);
});

test("successful writes return the existing adapter receipt and row values", () => {
  using f = fixture();
  expect(acquire(f.storage)).toEqual({ ok: true, fence: 1 });
  expect(
    Effect.runSync(
      f.storage.sessions.renewLease({
        sessionId: "session",
        owner: "writer",
        fence: 1,
        now: 2,
        expiresAt: 200,
      }),
    ),
  ).toBe(true);
  const result = Effect.runSync(f.storage.sessions.commit(f.input));
  expect(result.ok).toBe(true);
  expect(f.storage.sessions.get("session")).toEqual(result.row);
  expect(result.receipts.map((receipt) => receipt.action)).toEqual(
    sessionTree("session", f.storage.actions),
  );
  expect(result.receipts.map((receipt) => receipt.revision)).toEqual([1]);
  expect(f.storage.actions.verifyChain("session")).toMatchObject({ kind: "intact" });
  const armed = Effect.runSync(
    f.storage.alarms.arm({ id: "alarm", sessionId: "session", kind: "at", fireAt: 10 }),
  );
  expect(f.storage.alarms.get("alarm")).toEqual(armed);
  const fired = Effect.runSync(f.storage.alarms.fire(fire));
  expect(f.storage.inbox.list("session")).toEqual([fired.inbox]);
  expect(fired.receipts.map((receipt) => [receipt.action.kind, receipt.revision])).toEqual([
    ["alarm.fired", 3],
    ["prompt", 4],
  ]);
});

test("LedgerLive uses the opened storage and refuses missing capabilities", () => {
  using f = fixture();
  const live = LedgerLive(f.storage);
  const lease = Effect.runSync(
    Effect.provide(
      Effect.flatMap(LedgerWrites, (writes) =>
        writes.sessions.acquireLease({
          sessionId: "session",
          owner: "writer",
          expectedFence: 0,
          now: 1,
          expiresAt: 100,
        }),
      ),
      live,
    ),
  );
  expect(lease).toEqual({ ok: true, fence: 1 });
  expect(f.storage.sessions.get("session")?.leaseOwner).toBe("writer");
  expect(
    Effect.runSync(
      Effect.flip(Effect.provide(LedgerWrites, LedgerLive({ transaction: (op) => op() }))),
    ),
  ).toMatchObject({
    _tag: "StorageUnavailable",
    capability: "sessions",
  });
});

test("caller cancellation before SQLite commit cannot split alarm prompt and inbox", async () => {
  using f = fixture();
  Effect.runSync(
    f.storage.alarms.arm({ id: "alarm", sessionId: "session", kind: "at", fireAt: 10 }),
  );
  const controller = new AbortController();
  let observedAbort = false;
  controller.signal.addEventListener(
    "abort",
    () => {
      observedAbort = true;
    },
    { once: true },
  );
  const transaction = f.storage.transaction.bind(f.storage);
  const cancel = spyOn(f.storage, "transaction").mockImplementation((operation) =>
    transaction(() => {
      const result = operation();
      controller.abort();
      return result;
    }),
  );
  const exit = await Effect.runPromiseExit(f.storage.alarms.fire(fire), {
    signal: controller.signal,
  });
  cancel.mockRestore();
  expect(observedAbort).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.isInterruptedOnly(exit.cause)).toBe(true);
  expect(controller.signal.aborted).toBe(true);
  expect(sessionTree("session", f.storage.actions).map((action) => action.kind)).toEqual([
    "alarm.arm",
    "alarm.fired",
    "prompt",
  ]);
  expect(f.storage.inbox.list("session")).toHaveLength(1);
  expect(f.storage.alarms.get("alarm")?.status).toBe("fired");
  expect(f.observations.map((event) => event.kind)).toEqual(["alarm.arm", "alarm.fired", "prompt"]);
});

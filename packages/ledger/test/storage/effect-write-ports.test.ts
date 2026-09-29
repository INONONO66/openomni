import { sessionTree } from "../helpers/session-tree";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { runLedgerSync } from "../helpers/effect";
import type { LedgerSession } from "@openomni/protocol";
import { openLedgerDatabase, observedL0Adapters, type L0Adapters } from "../helpers/ledger";
import type { L0Observation } from "@openomni/protocol";

function fixture(db: ReturnType<typeof openLedgerDatabase>): {
  adapter: L0Adapters;
  observations: L0Observation.ActionCommitted[];
  input: LedgerSession.Commit;
} {
  const { adapter, observations } = observedL0Adapters(db);
  runLedgerSync(
    adapter.sessions.create({
      id: "session",
      parentId: null,
      role: "resident",
      state: "idle",
      revision: 0,
      leaseOwner: null,
      leaseFence: 0,
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
    state: "running",
  };
  return { adapter, observations, input };
}

function adopt(adapter: L0Adapters) {
  return runLedgerSync(
    adapter.sessions.adoptFence({ sessionId: "session", owner: "writer", fence: 1 }),
  );
}

test("commit refusal is tagged with revision and fence and leaves no partial SQL or observation", () => {
  using db = openLedgerDatabase();
  const f = fixture(db);
  adopt(f.adapter);
  const before = f.adapter.sessions.get("session");
  const refused = runLedgerSync(
    Effect.flip(f.adapter.sessions.commit({ ...f.input, expectedRevision: 1 })),
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
  expect(f.adapter.sessions.get("session")).toEqual(before);
  expect(sessionTree("session", f.adapter.actions)).toEqual([]);
  expect(f.observations).toEqual([]);
});

test("a late commit CAS refusal rolls back actions already appended in the same transaction", () => {
  using db = openLedgerDatabase();
  const f = fixture(db);
  adopt(f.adapter);
  const before = f.adapter.sessions.get("session");
  db.run(
    "CREATE TRIGGER refuse_state BEFORE UPDATE OF state ON session BEGIN SELECT RAISE(IGNORE); END",
  );
  expect(runLedgerSync(Effect.flip(f.adapter.sessions.commit(f.input)))).toMatchObject({
    _tag: "CommitRefused",
    reason: "fence",
    currentFence: 1,
    currentRevision: 0,
  });
  expect(f.adapter.sessions.get("session")).toEqual(before);
  expect(sessionTree("session", f.adapter.actions)).toEqual([]);
  expect(f.observations).toEqual([]);
});

test("fence adoption races and SQL CAS loss preserve holder and fence in typed refusals", () => {
  using db = openLedgerDatabase();
  const f = fixture(db);
  adopt(f.adapter);
  // A rival re-presenting the already-adopted fence is refused stale.
  expect(
    runLedgerSync(
      Effect.flip(
        f.adapter.sessions.adoptFence({ sessionId: "session", owner: "contender", fence: 1 }),
      ),
    ),
  ).toMatchObject({
    _tag: "LeaseRefused",
    reason: "stale",
    holder: "writer",
    fence: 1,
    expiresAt: null,
  });
  db.run(
    "CREATE TRIGGER refuse_fence BEFORE UPDATE OF lease_fence ON session BEGIN SELECT RAISE(IGNORE); END",
  );
  expect(
    runLedgerSync(
      Effect.flip(
        f.adapter.sessions.adoptFence({ sessionId: "session", owner: "contender", fence: 2 }),
      ),
    ),
  ).toMatchObject({
    _tag: "LeaseRefused",
    reason: "stale",
    holder: "writer",
    fence: 1,
    expiresAt: null,
  });
  expect(f.adapter.sessions.get("session")).toMatchObject({
    leaseOwner: "writer",
    leaseFence: 1,
  });
});

test("a superseded fence commits in the typed channel after a successor adoption", () => {
  using db = openLedgerDatabase();
  const f = fixture(db);
  adopt(f.adapter);
  runLedgerSync(
    f.adapter.sessions.adoptFence({ sessionId: "session", owner: "successor", fence: 2 }),
  );
  expect(
    runLedgerSync(Effect.flip(f.adapter.sessions.commit({ ...f.input, now: 101 }))),
  ).toMatchObject({
    _tag: "CommitRefused",
    reason: "fence",
    fence: 1,
    currentFence: 2,
  });
  expect(sessionTree("session", f.adapter.actions)).toEqual([]);
});

test("successful writes return the existing adapter receipt and row values", () => {
  using db = openLedgerDatabase();
  const f = fixture(db);
  expect(adopt(f.adapter)).toEqual({ ok: true, fence: 1 });
  // Re-adoption of the same owner+fence pair is idempotent.
  expect(adopt(f.adapter)).toEqual({ ok: true, fence: 1 });
  const result = runLedgerSync(f.adapter.sessions.commit(f.input));
  expect(result.ok).toBe(true);
  expect(f.adapter.sessions.get("session")).toEqual(result.row);
  expect(result.receipts.map((receipt) => receipt.action)).toEqual(
    sessionTree("session", f.adapter.actions),
  );
  expect(result.receipts.map((receipt) => receipt.revision)).toEqual([1]);
  expect(f.adapter.actions.verifyChain("session")).toMatchObject({ kind: "intact" });
  expect(f.observations.map((event) => event.id)).toEqual(["action"]);
});

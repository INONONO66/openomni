import { afterEach, beforeEach, expect, test } from "bun:test";
import type { LedgerAction, LedgerSession } from "@openomni/protocol";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

const sessionId = "commit-fencing";

function stores() {
  const sessions = Storage.get().sessions;
  const actions = Storage.get().actions;
  if (sessions === undefined || actions === undefined)
    throw new Error("SQLite kernel adapters are missing");
  return { sessions, actions };
}

function resultAction(id: string): LedgerAction.Append {
  return {
    id,
    parentId: null,
    sessionId,
    kind: "turn",
    intent: { encodingVersion: 1, value: { phase: "terminal" } },
    effect: { encodingVersion: 1, value: { terminal: "result" } },
    irreversible: true,
    ts: 10_001,
  };
}

function commitAs(fence: number, actionId: string): LedgerSession.Commit {
  return {
    sessionId,
    owner: "kernel-owner",
    fence,
    now: 10_001,
    expectedRevision: 0,
    actions: [resultAction(actionId)],
    consumeInboxIds: [],
    state: "idle",
    releaseLease: false,
  };
}

// C003: commit-time writer fencing. Owner A's lease expires mid-flight and a
// successor re-acquires under the SAME owner name, so the fence is the only
// discriminator left. A's result commit must be REJECTED as a typed stale
// outcome atomically: no action row, no revision movement, lease untouched.
test("a stale fence is rejected at commit time with no partial row, even under the same owner name", () => {
  const { sessions, actions } = stores();
  expect(
    sessions.create({
      id: sessionId,
      parentId: null,
      role: "resident",
      leaseOwner: null,
      leaseFence: 0,
      leaseExpiresAt: null,
      revision: 0,
      state: "idle",
      toolsGeneration: 0,
      systemHash: "",
      policyGeneration: 0,
    }),
  ).toBe(true);
  expect(
    sessions.acquireLease({
      sessionId,
      owner: "kernel-owner",
      expectedFence: 0,
      now: 0,
      expiresAt: 10_000,
    }),
  ).toEqual({ ok: true, fence: 1 });
  // Inclusive expiry: the successor reclaims at exactly expiresAt with the same owner name.
  expect(
    sessions.acquireLease({
      sessionId,
      owner: "kernel-owner",
      expectedFence: 1,
      now: 10_000,
      expiresAt: 40_000,
    }),
  ).toEqual({ ok: true, fence: 2 });
  const before = sessions.get(sessionId);
  expect(before).toMatchObject({ leaseOwner: "kernel-owner", leaseFence: 2, revision: 0 });

  // Owner name matches, the live lease is unexpired, the revision is exact:
  // only the fence is stale, and the rejection is typed with the current fence.
  const rejected = sessions.commit(commitAs(1, "stale-result"));
  expect(rejected).toEqual({ ok: false, reason: "stale", currentFence: 2, currentRevision: 0 });
  expect(actions.tree(sessionId)).toEqual([]);
  expect(sessions.get(sessionId)).toEqual(before);

  // The successor's fence commits the identical work exactly once.
  const committed = sessions.commit(commitAs(2, "successor-result"));
  expect(committed?.ok).toBe(true);
  if (committed?.ok !== true) throw new Error("successor commit was refused");
  expect(committed.row).toMatchObject({ revision: 1, leaseFence: 2 });
  expect(actions.tree(sessionId).map((action) => action.id)).toEqual(["successor-result"]);
});

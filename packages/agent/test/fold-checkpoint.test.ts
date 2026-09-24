import { Effect } from "effect";
import { runFixtureSync } from "./helpers/effect-result";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { SessionHandleStore, SqliteStorageAdapter, Storage } from "@openomni/ledger";
import { sessionTree } from "../../ledger/test/helpers/session-tree";
import { canonicalDigest, FoldCheckpoint, PlainValueSchema } from "@openomni/protocol";
import { foldHistoryState, hydrateSessionHistory } from "../src/session-lifecycle/history";
import { deliveryActions } from "../src/session-record";
import { bounded } from "./helpers/bounded";
import { effectOf, intentOf } from "./helpers/crash-matrix";
import { nth } from "./helpers/nth";
import { requestLedger } from "./helpers/request-ledger";
import {
  paddingActions,
  reconstructionFixture,
  reconstructionSession,
} from "./helpers/reconstruction-fixture";

let adapter: SqliteStorageAdapter;
beforeEach(() => {
  adapter = new SqliteStorageAdapter(":memory:");
  Storage.configure(adapter);
});
afterEach(() => Storage.reset());

function expectReplay(sessionId: string) {
  const hydrated = hydrateSessionHistory(sessionId);
  const full = foldHistoryState(sessionId, sessionTree(sessionId));
  expect(canonicalDigest(PlainValueSchema.parse(hydrated.state))).toBe(
    canonicalDigest(PlainValueSchema.parse(full)),
  );
  return hydrated;
}

test("below-interval audit commits do not replay the unchanged history prefix", () => {
  const recording = requestLedger();
  const range = spyOn(adapter.actions, "range");
  try {
    expect(
      recording.commitBatch(
        paddingActions(recording.identity.sessionId, recording.identity.turnId, 1),
      ).ok,
    ).toBe(true);
    expect(range).not.toHaveBeenCalled();
  } finally {
    range.mockRestore();
  }
  expectReplay(recording.identity.sessionId);
});

for (const count of [255, 256, 257]) {
  test(`durable cadence at ${count} non-checkpoint actions, including empty suffix`, () => {
    const recording = requestLedger();
    const id = recording.identity.sessionId;
    const committed = recording.commitBatch(
      paddingActions(id, recording.identity.turnId, count - 2),
    );
    expect(committed.ok).toBe(true);
    const actions = sessionTree(id);
    const checkpoints = actions.filter((action) => action.kind === "fold.checkpoint");
    expect(checkpoints).toHaveLength(count >= 256 ? 1 : 0);
    if (count >= 256) {
      const checkpoint = nth(checkpoints, 0);
      expect(checkpoint.ordinal).toBe(257);
      const result = FoldCheckpoint.Effect.parse(checkpoint.effect.value).result;
      expect(result.revision).toBe(256);
      expect(result.stateHash).toBe(
        canonicalDigest({
          foldVersion: 1,
          state: PlainValueSchema.parse(
            foldHistoryState(
              id,
              actions.filter((action) => action.ordinal <= result.revision),
            ),
          ),
        }),
      );
    }
    const loaded = expectReplay(id);
    expect(loaded.revision).toBe(actions.length);
    expect(loaded.nonCheckpointActions).toBe(count >= 256 ? count - 256 : count);
    expect(() => adapter.actions.range(id, 0, 257)).toThrow();
    expect(() => SessionHandleStore.historyPage(id, { limit: 257 })).toThrow();
    expect("tree" in SessionHandleStore).toBe(false);
  });
}

test("legacy genesis paging fixes a high-water revision, then checkpoints under the existing fence", () => {
  const recording = requestLedger({ legacy: true });
  const id = recording.identity.sessionId;
  for (const action of paddingActions(id, recording.identity.turnId, 600, "legacy")) {
    expect(adapter.actions.append(action, SessionHandleStore.row(id).revision)).toBeDefined();
  }
  const original = sessionTree(id);
  const revision = SessionHandleStore.row(id).revision;
  const range = adapter.actions.range.bind(adapter.actions);
  const cursors: number[] = [];
  adapter.actions.range = (sessionId, cursor, limit) => {
    cursors.push(cursor);
    expect(limit).toBeLessThanOrEqual(256);
    const page = range(sessionId, cursor, limit);
    if (cursors.length === 1) {
      expect(
        adapter.actions.append(
          nth(paddingActions(id, recording.identity.turnId, 1, "concurrent"), 0),
          revision,
        ),
      ).toBeDefined();
    }
    return page;
  };
  const loaded = hydrateSessionHistory(id);
  adapter.actions.range = range;
  expect(loaded.revision).toBe(revision);
  expect(cursors).toEqual([0, 256, 512]);
  expect(canonicalDigest(PlainValueSchema.parse(loaded.state))).toBe(
    canonicalDigest(PlainValueSchema.parse(foldHistoryState(id, original))),
  );
  expect(recording.commitBatch([]).ok).toBe(true);
  expect(SessionHandleStore.latestFoldCheckpoint(id).checkpoint?.ordinal).toBe(revision + 2);
  expect(sessionTree(id).slice(0, original.length)).toEqual(original);
  expectReplay(id);
});

test("a compaction below N commits result and checkpoint together, rolls both back inside SQLite, and refuses a stale CAS", async () => {
  let cuts = 0;
  const rollback = new Error("injected transaction rollback");
  const fixture = await reconstructionFixture(
    (action, recording) => Effect.gen(function* () {
      if (
        action.kind === "compaction" &&
        effectOf(action).phase === "result" &&
        effectOf(action).terminal === "executed"
      ) {
        const before = sessionTree(reconstructionSession);
        const revision = SessionHandleStore.row(reconstructionSession).revision;
        expect(() => recording.commitBatch([action], { expectedRevision: revision - 1 })).toThrow();
        expect(sessionTree(reconstructionSession)).toEqual(before);
        expect(() =>
          Storage.get().transaction(() => {
            expect(recording.commitBatch([action]).ok).toBe(true);
            const pending = sessionTree(reconstructionSession).slice(before.length);
            expect(pending.map((node) => node.kind)).toEqual(["compaction", "fold.checkpoint"]);
            throw rollback;
          }),
        ).toThrow(rollback);
        expect(sessionTree(reconstructionSession)).toEqual(before);
        cuts += 1;
      }
      return yield* recording.ledger.commit(action);
    }),
    { updates: 2, padding: 0 },
  );
  await fixture.compact();
  expect(cuts).toBe(1);
  expect(fixture.bodies).toEqual(["tool", "summary"]);
  expect(fixture.publications).toHaveLength(1);
  const actions = sessionTree(reconstructionSession);
  expect(actions.length).toBeLessThan(256);
  const checkpoint = nth(actions.slice(-1), 0);
  const result = nth(actions.slice(-2), 0);
  expect(checkpoint.kind).toBe("fold.checkpoint");
  expect(FoldCheckpoint.Effect.parse(checkpoint.effect.value).result.state.successorActionId).toBe(
    result.id,
  );
  const loaded = expectReplay(reconstructionSession);
  expect(effectOf(result).result).toMatchObject({
    successorActionId: result.id,
    foldVersion: 1,
    messageIds: loaded.history.map((message) => message.info.id),
    projectionHash: canonicalDigest({
      foldVersion: 1,
      projection: PlainValueSchema.parse(loaded.history),
    }),
  });
});

for (const change of ["replacement", "delivered-tail"] as const) {
  test(`prepared compaction refuses a later ${change} without overwriting or dropping it`, async () => {
    const fixture = await reconstructionFixture(undefined, { updates: 2, padding: 0 });
    const prepared = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<string>();
    const pending = fixture.compact(() => {
      prepared.resolve();
      return finish.promise;
    });
    const settled = Promise.allSettled([pending]);
    await bounded(prepared.promise);
    const intent = nth(
      sessionTree(reconstructionSession)
        .filter((action) => action.kind === "compaction" && intentOf(action).phase === "intent")
        .slice(-1),
      0,
    );
    if (change === "replacement") await fixture.compact(async () => "replacement");
    else {
      const incoming = runFixtureSync(SessionHandleStore.commitReceivedMessage({
        id: "concurrent",
        sessionId: reconstructionSession,
        kind: "prompt",
        content: "tail",
        createdAt: 100,
        origin: { encodingVersion: 1, value: {} },
        parentActionId: null,
      }));
      expect(
        fixture.recording.commitBatch(
          deliveryActions(
            [incoming.row],
            fixture.recording.identity.turnId,
            "after_tools",
            incoming.receipt.action.id,
          ),
          { consumeInboxIds: [incoming.row.id] },
        ).ok,
      ).toBe(true);
    }
    const before = hydrateSessionHistory(reconstructionSession).history;
    finish.resolve("stale summary");
    expect(await bounded(settled)).toMatchObject([
      {
        status: "rejected",
        reason: {
          name: "CompactionPredecessorError",
          data: { code: "compaction_predecessor_changed" },
        },
      },
    ]);
    expect(SessionHandleStore.resultFor(reconstructionSession, intent.id)).toBeUndefined();
    expect(expectReplay(reconstructionSession).history).toEqual(before);
    if (change === "delivered-tail")
      expect(before.map((message) => message.info.id)).toEqual([
        "prior-result",
        "same-id",
        "answer",
        "tool-message",
        "concurrent",
      ]);
  });
}

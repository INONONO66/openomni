import { Effect } from "effect";
import { runAgentSync } from "./helpers/executor";
import { expect, spyOn, test } from "bun:test";
import * as SessionHandleStore from "../src/core/store/fence";
import { sessionTree } from "./helpers/session-tree";
import { canonicalDigest, FoldCheckpoint, PlainValueSchema } from "@openomni/protocol";
import { foldHistoryState, hydrateSessionHistory } from "../src/inspect/history";
import { deliveryActions } from "../src/core/commit";
import { bounded } from "./helpers/bounded";
import { effectOf, intentOf } from "./helpers/crash-matrix";
import { commitReceivedMessage } from "./helpers/ingress";
import { isolatedLedger, isolatedRun } from "./helpers/isolated";
import { nth } from "./helpers/nth";
import { requestLedger } from "./helpers/request-ledger";
import { textMessage } from "./helpers/messages";
import { paddingActions, reconstructionFixture, reconstructionSession, } from "./helpers/reconstruction-fixture";

function expectReplay(sessionId: string) {
  const kernel = isolatedLedger().kernel;
  const hydrated = hydrateSessionHistory(kernel, sessionId);
  const full = foldHistoryState(sessionId, sessionTree(kernel, sessionId));
  expect(canonicalDigest(PlainValueSchema.parse(hydrated.state))).toBe(
    canonicalDigest(PlainValueSchema.parse(full)),
  );
  return hydrated;
}

test("below-interval audit commits do not replay the unchanged history prefix", () => isolatedRun((ledger) => {
  const recording = requestLedger();
  const range = spyOn(ledger.session.actions, "range");
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
}));

for (const count of [255, 256, 257]) {
  test(`durable cadence at ${count} non-checkpoint actions, including empty suffix`, () => isolatedRun((ledger) => {
    const recording = requestLedger();
    const id = recording.identity.sessionId;
    const committed = recording.commitBatch(
      paddingActions(id, recording.identity.turnId, count - 2),
    );
    expect(committed.ok).toBe(true);
    const actions = sessionTree(ledger.kernel, id);
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
    expect(() => ledger.session.actions.range(id, 0, 257)).toThrow();
    expect(() => ledger.kernel.historyPage(id, { limit: 257 })).toThrow();
    expect("tree" in SessionHandleStore).toBe(false);
  }));
}

test("legacy genesis paging fixes a high-water revision, then checkpoints under the existing fence", () => isolatedRun((ledger) => {
  const recording = requestLedger({ legacy: true });
  const id = recording.identity.sessionId;
  const kernel = ledger.kernel;
  for (const action of paddingActions(id, recording.identity.turnId, 600, "legacy")) {
    expect(ledger.session.actions.append(action, kernel.row(id).revision)).toBeDefined();
  }
  const original = sessionTree(kernel, id);
  const revision = kernel.row(id).revision;
  const range = ledger.session.actions.range.bind(ledger.session.actions);
  const cursors: number[] = [];
  ledger.session.actions.range = (sessionId, cursor, limit) => {
    cursors.push(cursor);
    expect(limit).toBeLessThanOrEqual(256);
    const page = range(sessionId, cursor, limit);
    if (cursors.length === 1) {
      expect(
        ledger.session.actions.append(
          nth(paddingActions(id, recording.identity.turnId, 1, "concurrent"), 0),
          revision,
        ),
      ).toBeDefined();
    }
    return page;
  };
  const loaded = hydrateSessionHistory(kernel, id);
  ledger.session.actions.range = range;
  expect(loaded.revision).toBe(revision);
  expect(cursors).toEqual([0, 256, 512]);
  expect(canonicalDigest(PlainValueSchema.parse(loaded.state))).toBe(
    canonicalDigest(PlainValueSchema.parse(foldHistoryState(id, original))),
  );
  expect(recording.commitBatch([]).ok).toBe(true);
  expect(kernel.latestFoldCheckpoint(id).checkpoint?.ordinal).toBe(revision + 2);
  expect(sessionTree(kernel, id).slice(0, original.length)).toEqual(original);
  expectReplay(id);
}));

test("a compaction below N commits result and checkpoint together, rolls both back inside SQLite, and refuses a stale CAS", () => isolatedRun(async (ledger) => {
  let cuts = 0;
  const rollback = new Error("injected transaction rollback");
  const kernel = ledger.kernel;
  const fixture = await reconstructionFixture(
    (action, recording) => Effect.gen(function* () {
      if (
        action.kind === "compaction" &&
        effectOf(action).phase === "result" &&
        effectOf(action).terminal === "executed"
      ) {
        const before = sessionTree(kernel, reconstructionSession);
        const revision = kernel.row(reconstructionSession).revision;
        expect(() => recording.commitBatch([action], { expectedRevision: revision - 1 })).toThrow();
        expect(sessionTree(kernel, reconstructionSession)).toEqual(before);
        expect(() =>
          ledger.session.transaction(() => {
            expect(recording.commitBatch([action]).ok).toBe(true);
            const pending = sessionTree(kernel, reconstructionSession).slice(before.length);
            expect(pending.map((node) => node.kind)).toEqual(["compaction", "fold.checkpoint"]);
            throw rollback;
          }),
        ).toThrow(rollback);
        expect(sessionTree(kernel, reconstructionSession)).toEqual(before);
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
  const actions = sessionTree(kernel, reconstructionSession);
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
}));

test("legacy compaction without captured context reconstructs its predecessor before committing the successor", () => isolatedRun((ledger) => {
  const recording = requestLedger({ legacy: true });
  const sessionId = recording.identity.sessionId;
  const kernel = ledger.kernel;
  const prior = hydrateSessionHistory(kernel, sessionId);
  const history = [textMessage("assistant", "legacy summary", sessionId, "legacy-summary")];
  const projection = PlainValueSchema.parse(history);
  const predecessorProjectionHash = canonicalDigest({
    foldVersion: 1,
    projection: PlainValueSchema.parse(prior.history),
  });
  expect(ledger.session.actions.append({
    id: "legacy-compaction", sessionId, parentId: recording.identity.turnId,
    kind: "compaction", ts: 100, irreversible: true,
    intent: { encodingVersion: 1, value: { phase: "intent", op: "compact" } },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
  }, prior.revision)?.revision).toBe(prior.revision + 1);
  expect(recording.commitBatch([{
    id: "legacy-compaction:result", sessionId, parentId: "legacy-compaction",
    kind: "compaction", ts: 100, irreversible: true,
    intent: { encodingVersion: 1, value: { phase: "result", op: "compact" } },
    effect: { encodingVersion: 1, value: {
      phase: "result", terminal: "executed", result: { projection },
    } },
  }]).ok).toBe(true);
  const result = kernel.resultFor(sessionId, "legacy-compaction");
  if (result === undefined) throw new Error("missing legacy compaction result");
  expect(effectOf(result).result).toEqual({
    sourceRevision: prior.revision,
    foldVersion: 1,
    predecessorActionId: null,
    predecessorProjectionHash,
    successorActionId: "legacy-compaction:result",
    messageIds: ["legacy-summary"],
    projection,
    projectionHash: canonicalDigest({ foldVersion: 1, projection }),
  });
  expect(expectReplay(sessionId).history).toEqual(history);
}));

for (const change of ["replacement", "delivered-tail"] as const) {
  test(`prepared compaction refuses a later ${change} without overwriting or dropping it`, () => isolatedRun(async (ledger) => {
    const kernel = ledger.kernel;
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
      sessionTree(kernel, reconstructionSession)
        .filter((action) => action.kind === "compaction" && intentOf(action).phase === "intent")
        .slice(-1),
      0,
    );
    if (change === "replacement") await fixture.compact(async () => "replacement");
    else {
      const incoming = runAgentSync(commitReceivedMessage(kernel, {
        id: "concurrent",
        sessionId: reconstructionSession,
        kind: "prompt",
        content: "tail",
        createdAt: 100,
        origin: { encodingVersion: 1, value: {} },
        parentActionId: kernel.latestAction(reconstructionSession)?.id ?? null,
      }));
      const row = kernel.pendingMessages(reconstructionSession).find((item) => item.id === "concurrent");
      if (row === undefined) throw new Error("missing concurrent ingress row");
      expect(
        fixture.recording.commitBatch(
          deliveryActions(
            [row],
            { kind: "turn", turnId: fixture.recording.identity.turnId },
            "after_tools",
            incoming.receipt.action.id,
          ),
        ).ok,
      ).toBe(true);
    }
    const before = hydrateSessionHistory(kernel, reconstructionSession).history;
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
    expect(kernel.resultFor(reconstructionSession, intent.id)).toBeUndefined();
    expect(expectReplay(reconstructionSession).history).toEqual(before);
    if (change === "delivered-tail")
      expect(before.map((message) => message.info.id)).toEqual([
        "prior-result",
        "same-id",
        "answer",
        "tool-message",
        "concurrent",
      ]);
  }));
}

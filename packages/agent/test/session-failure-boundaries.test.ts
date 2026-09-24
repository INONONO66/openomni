import { sessionTree } from "../../ledger/test/helpers/session-tree";
import { allowConfigure, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";
import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { SessionHandleStore } from "@openomni/ledger";
import { PlainObjectSchema, type LedgerAction } from "@openomni/protocol";
import { session, type SessionRunnerInput } from "../src/session-handle";
import { isolated } from "./helpers/isolated";
import { openRequest } from "./helpers/open-request";
import { seedPolicy } from "./helpers/seed-policy";

const runtime: SessionRuntime = {
  authorizeConfigure: allowConfigure,
  observations: { publish: (): void => undefined },
  clock: (): number => 100,
  scheduleHeartbeat: (): (() => void) => (): void => undefined,
};

test("a completed turn's captured ledger rejects late writes without appending", () => isolated(Effect.scoped(Effect.gen(function* () {
  seedPolicy();
  const entered = yield* Deferred.make<SessionRunnerInput>();
  const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({
    id: "late-write", role: "resident",
    runner: (input: SessionRunnerInput) => Deferred.succeed(entered, input).pipe(Effect.as({ kind: "result" as const, text: "done" })),
  }, fixture), fixture); });
  yield* handle.prompt("start");
  const input = yield* Deferred.await(entered);
  const before = sessionTree(handle.id);
  const action: LedgerAction.Append = {
    id: "late", sessionId: handle.id, parentId: input.turnId, kind: "tool",
    intent: { encodingVersion: 1, value: {} }, effect: { encodingVersion: 1, value: {} }, ts: 100, irreversible: true,
  };
  expect(yield* Effect.flip(input.ledger.commit(action))).toMatchObject({
    _tag: "CommitRefused", sessionId: handle.id, reason: "fence",
  });
  expect(sessionTree(handle.id)).toEqual(before);
}))));

test("request transitions cannot renew an expired lease beneath a live runner", () => isolated(Effect.scoped(Effect.gen(function* () {
  seedPolicy();
  let now = 100;
  const entered = yield* Deferred.make<SessionRunnerInput>();
  const release = yield* Deferred.make<void>();
  const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = { ...runtime, clock: (): number => now }; return yield* withSessionServices(session({
    id: "expired-transition", role: "resident",
    runner: (input: SessionRunnerInput) => Effect.gen(function* () {
      yield* Deferred.succeed(entered, input);
      yield* Deferred.await(release);
      return { kind: "result", text: "done" };
    }),
  }, fixture), fixture); });
  const running = yield* Effect.fork(handle.prompt("start"));
  const input = yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"));
  const before = SessionHandleStore.row(handle.id);
  now += SessionHandleStore.LEASE_TTL_MS;
  const request = openRequest({ requestId: "request", sessionId: handle.id, turnId: input.turnId, callId: "call" });
  expect(yield* Effect.flip(handle.requests.transition({ kind: "request.open", request }, "open", now))).toMatchObject({
    _tag: "CommitFailed", error: { _tag: "LeaseRefused", reason: "stale", fence: before.leaseFence },
  });
  expect(SessionHandleStore.row(handle.id)).toEqual(before);
  expect(SessionHandleStore.requestRows(handle.id)).toEqual([]);
  now = 100;
  yield* Deferred.succeed(release, undefined);
  expect(yield* Fiber.join(running)).toMatchObject({ kind: "result", text: "done" });
}))));

test("an idle request transition preserves a competing owner's lease and typed refusal", () => isolated(Effect.scoped(Effect.gen(function* () {
  seedPolicy();
  const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({
    id: "held-transition", role: "resident", runner: () => Effect.succeed({ kind: "result", text: "unused" }),
  }, fixture), fixture); });
  yield* SessionHandleStore.acquireLease({
    sessionId: handle.id, owner: "other", expectedFence: 0, now: 100, expiresAt: 1000,
  });
  const before = SessionHandleStore.row(handle.id);
  const request = openRequest({ requestId: "request", sessionId: handle.id, turnId: "turn", callId: "call" });
  expect(yield* Effect.flip(handle.requests.transition({ kind: "request.open", request }, "open", 100))).toMatchObject({
    _tag: "CommitFailed", error: { _tag: "LeaseRefused", reason: "held", holder: "other", fence: 1 },
  });
  expect(SessionHandleStore.row(handle.id)).toEqual(before);
  expect(SessionHandleStore.requestRows(handle.id)).toEqual([]);
}))));

for (const count of [1, 257]) {
  test(`zero-grace shutdown seals ${count} open turns and pending tools before releasing the lease`, () => isolated(Effect.scoped(Effect.gen(function* () {
    seedPolicy();
    const entered = yield* Deferred.make<SessionRunnerInput>();
    const fixture: SessionFixture = { ...runtime, closeGraceMs: 0 };
    const handle = yield* withSessionServices(session({
      id: "shutdown-pending", role: "resident",
      runner: (input: SessionRunnerInput) => Effect.gen(function* () {
        const turn = SessionHandleStore.actionById(input.turnId);
        if (turn === undefined) throw new Error("missing active turn");
        const intent = PlainObjectSchema.parse(turn.intent.value);
        for (let index = 1; index < count; index += 1) {
          yield* input.ledger.commit({
            id: `open-turn:${index}`, sessionId: input.sessionId, parentId: input.turnId, kind: "turn",
            intent: { encodingVersion: 1, value: { ...intent, resultId: `open-turn:${index}:result` } },
            effect: { encodingVersion: 1, value: { phase: "pending" } }, ts: 100, irreversible: true,
          }).pipe(Effect.orDie);
        }
        // All operations belong to the oldest turn, beyond the first reverse page.
        for (let index = 0; index < count; index += 1) {
          yield* input.ledger.commit({
            id: `pending-tool:${index}`, sessionId: input.sessionId, parentId: input.turnId, kind: "tool",
            intent: { encodingVersion: 1, value: { phase: "intent", turnId: input.turnId } },
            effect: { encodingVersion: 1, value: { phase: "pending" } }, ts: 100, irreversible: true,
          }).pipe(Effect.orDie);
        }
        yield* Deferred.succeed(entered, input);
        return yield* Effect.never;
      }),
    }, fixture), fixture);
    const running = yield* Effect.fork(handle.prompt("start"));
    const input = yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"));
    yield* handle.close();
    yield* Fiber.join(running);
    for (let index = 0; index < count; index += 1) {
      expect(SessionHandleStore.resultFor(handle.id, `pending-tool:${index}`)?.effect.value).toEqual({
        phase: "result", terminal: "outcome_unknown", reason: "shutdown_grace_exhausted",
      });
      const turnId = index === 0 ? input.turnId : `open-turn:${index}`;
      expect(SessionHandleStore.turnTerminalFor(handle.id, turnId)?.kind).toBe("interrupted");
    }
    expect(SessionHandleStore.openTurnsPage(handle.id)).toEqual([]);
    expect(SessionHandleStore.openOperationsPage(handle.id, input.turnId)).toEqual([]);
    expect(SessionHandleStore.row(handle.id).leaseOwner).toBeNull();
  }))));
}

import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { SessionHandleStore } from "@openomni/ledger";
import type { LedgerAction } from "@openomni/protocol";
import { session, type SessionRunnerInput, type SessionRuntime } from "../src/session-handle";
import { isolated } from "./helpers/isolated";
import { openRequest } from "./helpers/open-request";
import { seedPolicy } from "./helpers/seed-policy";

const runtime: SessionRuntime = {
  observations: { publish: (): void => undefined },
  clock: (): number => 100,
  scheduleHeartbeat: (): (() => void) => (): void => undefined,
};

test("a completed turn's captured ledger rejects late writes without appending", () => isolated(Effect.scoped(Effect.gen(function* () {
  seedPolicy();
  const entered = yield* Deferred.make<SessionRunnerInput>();
  const handle = yield* session({
    id: "late-write", role: "resident",
    runner: (input: SessionRunnerInput) => Deferred.succeed(entered, input).pipe(Effect.as({ kind: "result" as const, text: "done" })),
  }, runtime);
  yield* handle.prompt("start");
  const input = yield* Deferred.await(entered);
  const before = SessionHandleStore.tree(handle.id);
  const action: LedgerAction.Append = {
    id: "late", sessionId: handle.id, parentId: input.turnId, kind: "tool",
    intent: { encodingVersion: 1, value: {} }, effect: { encodingVersion: 1, value: {} }, ts: 100, irreversible: true,
  };
  expect(yield* Effect.flip(input.ledger.commit(action))).toMatchObject({
    _tag: "CommitRefused", sessionId: handle.id, reason: "fence",
  });
  expect(SessionHandleStore.tree(handle.id)).toEqual(before);
}))));

test("request transitions cannot renew an expired lease beneath a live runner", () => isolated(Effect.scoped(Effect.gen(function* () {
  seedPolicy();
  let now = 100;
  const entered = yield* Deferred.make<SessionRunnerInput>();
  const release = yield* Deferred.make<void>();
  const handle = yield* session({
    id: "expired-transition", role: "resident",
    runner: (input: SessionRunnerInput) => Effect.gen(function* () {
      yield* Deferred.succeed(entered, input);
      yield* Deferred.await(release);
      return { kind: "result", text: "done" };
    }),
  }, { ...runtime, clock: (): number => now });
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
  const handle = yield* session({
    id: "held-transition", role: "resident", runner: () => Effect.succeed({ kind: "result", text: "unused" }),
  }, runtime);
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

test("zero-grace shutdown seals pending tool evidence before releasing the turn lease", () => isolated(Effect.scoped(Effect.gen(function* () {
  seedPolicy();
  const entered = yield* Deferred.make<void>();
  const handle = yield* session({
    id: "shutdown-pending", role: "resident",
    runner: (input: SessionRunnerInput) => Effect.gen(function* () {
      yield* input.ledger.commit({
        id: "pending-tool", sessionId: input.sessionId, parentId: input.turnId, kind: "tool",
        intent: { encodingVersion: 1, value: { phase: "intent" } },
        effect: { encodingVersion: 1, value: { phase: "pending" } }, ts: 100, irreversible: true,
      }).pipe(Effect.orDie);
      yield* Deferred.succeed(entered, undefined);
      return yield* Effect.never;
    }),
  }, { ...runtime, closeGraceMs: 0 });
  const running = yield* Effect.fork(handle.prompt("start"));
  yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"));
  yield* handle.close();
  yield* Fiber.join(running);
  const results = SessionHandleStore.tree(handle.id).filter((action: LedgerAction.Node) => action.parentId === "pending-tool");
  expect(results).toContainEqual(expect.objectContaining({
    kind: "tool", effect: { encodingVersion: 1, value: { phase: "result", terminal: "outcome_unknown", reason: "shutdown_grace_exhausted" } },
  }));
  expect(SessionHandleStore.row(handle.id).leaseOwner).toBeNull();
}))));

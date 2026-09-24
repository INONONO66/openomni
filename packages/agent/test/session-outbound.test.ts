import { sessionTree } from "../../ledger/test/helpers/session-tree";
import { allowConfigure, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";
import { Cause, Chunk, Effect, Exit, Scope } from "effect";
import { expect, test } from "bun:test";
import { seedPolicy } from "./helpers/seed-policy";
import { receiveOutbound, failure, foreign } from "./helpers/effect-g2";
import { isolated } from "./helpers/isolated";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { session, closeSessions, sweepSessions, wakeSession, type SessionRunner } from "../src/session-handle";
import type { LedgerSession } from "@openomni/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** The parent's pending commission answered by the child's outbound reply. */
function appendCommission(): void {
  const actions = Storage.get().actions;
  if (actions === undefined) throw new Error("missing action adapter");
  actions.append(
    {
      id: "commission-action",
      parentId: null,
      sessionId: "parent",
      kind: "message",
      intent: {
        encodingVersion: 1,
        value: { phase: "intent", value: { messageId: "commission" } },
      },
      effect: { encodingVersion: 1, value: { phase: "pending" } },
      ts: 100,
      irreversible: true,
    },
    SessionHandleStore.row("parent").revision,
  );
}
const origin = {
  encodingVersion: 1 as const,
  value: {
    kind: "message",
    messageId: "commission",
    senderSessionId: "parent",
    sourceActionId: "commission-action",
  },
};
const parentRunner: SessionRunner = () => Effect.succeed({ kind: "result", text: "parent" });
const childRunner: SessionRunner = () => Effect.succeed({ kind: "result", text: "child answer" });
function commissionedChild(runtime: SessionRuntime) {
  return Effect.gen(function* () {
    seedPolicy();
    yield* Effect.addFinalizer(() => closeSessions(runtime).pipe(Effect.orDie));
    yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({ id: "parent", role: "resident", runner: parentRunner }, fixture), fixture); });
    appendCommission();
    const child = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({ id: "child", parentId: "parent", role: "worker", runner: childRunner }, fixture), fixture); });
    return yield* child.prompt("work", origin);
  });
}

test("a dropped receiving consumer leaves a sealed source obligation without mutating its parent", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime: SessionRuntime = {
          observations: { publish: () => undefined },
          authorizeConfigure: allowConfigure,
          clock: () => 100,
          dispatchOutbound: () => Effect.fail(foreign("receiver", "unavailable")),
        };
        seedPolicy();
        yield* Effect.addFinalizer(() => closeSessions(runtime).pipe(Effect.orDie));
        yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({ id: "parent", role: "resident", runner: parentRunner }, fixture), fixture); });
        const child = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({ id: "child", parentId: "parent", role: "worker", runner: childRunner }, fixture), fixture); });
        const before = sessionTree("parent");
        expect(yield* failure(child.prompt("work", origin))).toMatchObject({
          _tag: "ForeignFailure",
          operation: "receiver",
          cause: "unavailable",
        });
        expect(sessionTree("parent")).toEqual(before);
        expect(SessionHandleStore.inboxRows("parent")).toEqual([]);
        const source = sessionTree("child");
        expect(
          source.filter(
            (action: import("@openomni/protocol").LedgerAction.Node) =>
              SessionHandleStore.turnTerminal(action) !== undefined,
          ),
        ).toHaveLength(1);
        const obligations = SessionHandleStore.outboundRows("child");
        expect(obligations).toHaveLength(1);
        expect(obligations[0]?.state).toBe("pending");
        expect(obligations[0]?.message.content).toBe("child answer");
      }),
    ),
  ));

test("restart after receiving commit retries exact bytes without another inbox or receiver execution", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        Storage.reset();
        const directory = mkdtempSync(join(tmpdir(), "source-obligation-"));
        const dbPath = join(directory, "ledger.sqlite");
        Storage.initialize({ dbPath });
        seedPolicy();
        const scope = yield* Effect.scope;
        let consumed = 0;
        const receive: SessionRunner = () =>
          Effect.sync(() => {
            consumed += 1;
            return { kind: "result" as const, text: "received" };
          });
        const sent: string[] = [];
        function runtime(at: number, loseAck: boolean): SessionRuntime {
          const value: SessionRuntime = {
            observations: { publish: () => undefined },
            authorizeConfigure: allowConfigure,
            clock: () => at,
            dispatchOutbound: ({
              message,
            }: Parameters<NonNullable<SessionRuntime["dispatchOutbound"]>>[0]) =>
              Effect.gen(function* () {
                sent.push(JSON.stringify(message));
                const received = yield* receiveOutbound(message, at);
                yield* Effect.gen(function* () { const fixture: SessionFixture = value; return yield* withSessionServices(wakeSession(message.destinationSessionId, receive, fixture), fixture); }).pipe(
                  Effect.provideService(Scope.Scope, scope),
                  Effect.orDie,
                );
                if (loseAck) return yield* foreign("source.ack", "lost");
                return received.receipt;
              }),
          };
          return value;
        }
        let current = runtime(100, true);
        try {
          yield* Effect.gen(function* () { const fixture: SessionFixture = current; return yield* withSessionServices(session({ id: "parent", role: "resident", runner: receive }, fixture), fixture); });
          appendCommission();
          const child = yield* Effect.gen(function* () { const fixture: SessionFixture = current; return yield* withSessionServices(session({
              id: "child",
              parentId: "parent",
              role: "worker",
              runner: () => Effect.succeed({ kind: "result", text: "exact answer" }),
            }, fixture), fixture); });
          expect(yield* failure(child.prompt("work", origin))).toMatchObject({
            _tag: "ForeignFailure",
            operation: "source.ack",
            cause: "lost",
          });
          expect(consumed).toBe(1);
          const parentBefore = sessionTree("parent");
          expect(SessionHandleStore.outboundRows("child")[0]?.state).toBe("pending");
          yield* closeSessions(current);
          Storage.reset();
          Storage.initialize({ dbPath });
          current = runtime(200, false);
          yield* Effect.gen(function* () { const fixture: SessionFixture = current; return yield* withSessionServices(sweepSessions((row: LedgerSession.Row) =>
              row.id === "parent" ? receive : () => Effect.die(new Error("sealed child replayed")), fixture), fixture); });
          expect(sent).toHaveLength(2);
          expect(sent[1]).toBe(sent[0]);
          expect(consumed).toBe(1);
          expect(sessionTree("parent")).toEqual(parentBefore);
          expect(SessionHandleStore.inboxRows("parent")).toHaveLength(1);
          expect(SessionHandleStore.outboundRows("child")[0]?.state).toBe("delivered");
        } finally {
          yield* closeSessions(current);
          Storage.reset();
          rmSync(directory, { recursive: true, force: true });
        }
      }),
    ),
  ));

test("a destination receipt for different bytes is refused and the obligation stays pending", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const prompted = commissionedChild({
          observations: { publish: () => undefined },
          authorizeConfigure: allowConfigure,
          clock: () => 100,
          dispatchOutbound: ({
            message,
          }: Parameters<NonNullable<SessionRuntime["dispatchOutbound"]>>[0]) =>
            receiveOutbound({ ...message, content: "tampered answer" }, 100).pipe(
              Effect.map(
                (received: Effect.Effect.Success<ReturnType<typeof receiveOutbound>>) =>
                  received.receipt,
              ),
            ),
        });
        expect(yield* failure(prompted)).toBeInstanceOf(Error);
        expect(SessionHandleStore.outboundRows("child")).toMatchObject([{ state: "pending" }]);
        expect(
          SessionHandleStore.inboxRows("parent").map(
            (row: import("@openomni/protocol").Inbox.Row) => row.content,
          ),
        ).toEqual(["tampered answer"]);
      }),
    ),
  ));

test("a lease stolen during dispatch preserves both the ack failure and the release defect", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const prompted = commissionedChild({
          observations: { publish: () => undefined },
          authorizeConfigure: allowConfigure,
          clock: () => 100,
          dispatchOutbound: ({
            message,
          }: Parameters<NonNullable<SessionRuntime["dispatchOutbound"]>>[0]) =>
            Effect.gen(function* () {
              yield* SessionHandleStore.acquireLease({
                sessionId: message.sourceSessionId,
                owner: "other-runtime",
                expectedFence: SessionHandleStore.row(message.sourceSessionId).leaseFence,
                now: 100 + SessionHandleStore.LEASE_TTL_MS,
                expiresAt: 100 + 2 * SessionHandleStore.LEASE_TTL_MS,
              }).pipe(Effect.orDie);
              return (yield* receiveOutbound(message, 100)).receipt;
            }),
        });
        const exit = yield* Effect.exit(prompted);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) throw new Error("expected lost-fence failures");
        expect([
          ...Chunk.toReadonlyArray(Cause.failures(exit.cause)),
          ...Chunk.toReadonlyArray(Cause.defects(exit.cause)),
        ]).toMatchObject([
          {
            _tag: "CommitFailed",
            error: { _tag: "CommitRefused", reason: "fence", sessionId: "child" },
          },
          {
            _tag: "CommitFailed",
            error: { _tag: "CommitRefused", reason: "fence", sessionId: "child" },
          },
        ]);
        expect(SessionHandleStore.outboundRows("child")).toMatchObject([{ state: "pending" }]);
        expect(SessionHandleStore.row("child").leaseOwner).toBe("other-runtime");
      }),
    ),
  ));

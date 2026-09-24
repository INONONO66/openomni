import { type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";
import { describe, expect, test } from "bun:test";
import { Cause, Effect } from "effect";
import { seedPolicy as seed } from "./helpers/seed-policy";
import { nth } from "./helpers/nth";
import { answerThenCompact } from "./helpers/effect-g2";
import { isolated } from "./helpers/isolated";
import { SessionHandleStore } from "@openomni/ledger";
import type { LedgerAction, Message, PlainObject } from "@openomni/protocol";
import { Bus, createTurnDispatcher, type SessionRunner } from "../src/index";
import { session } from "../src/session-handle";
import type { SessionHandle, SessionRunnerInput } from "../src/session-contract";
import { foldSessionHistory } from "../src/session-lifecycle/history";

let nextId = 0;
function runtime(): SessionRuntime {
  return {
    observations: Bus,
    clock: () => 1_000,
    entropy: () => `restore-id-${++nextId}`,
    processId: "restore-test",
    scheduleHeartbeat: () => () => undefined,
  };
}
function intentRecord(action: LedgerAction.Node): PlainObject {
  const value = action.intent.value;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
function compactionIntent(
  actions: readonly LedgerAction.Node[],
): LedgerAction.Node {
  const found = actions.find(
    (action: LedgerAction.Node) =>
      action.kind === "compaction" &&
      intentRecord(action).phase === "intent" &&
      intentRecord(action).op === "compact",
  );
  if (found === undefined) throw new Error("missing compaction intent");
  return found;
}
function program<E>(
  body: (
    handle: SessionHandle,
    before: readonly LedgerAction.Node[],
  ) => Effect.Effect<void, E>,
  rows: NonNullable<Parameters<typeof seed>[0]> = [],
) {
  return Effect.scoped(
    Effect.gen(function* () {
      seed(rows);

      const current = runtime();
      const compactingRunner: SessionRunner = (input: SessionRunnerInput) => Effect.gen(function* () {
        const { executor } = yield* createTurnDispatcher(input, current);
        return yield* answerThenCompact(executor, input);
      });
      const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = current; return yield* withSessionServices(session({ id: "ctx", role: "resident", runner: compactingRunner }, fixture), fixture); });
      yield* handle.prompt("hello");
      const before = SessionHandleStore.tree("ctx");
      yield* body(handle, before);
    }),
  );
}

describe("restore_context_projection", () => {
  test("appends the typed compensation, restores the prior projection and leaves the compaction intact", () =>
    isolated(
      program((handle: SessionHandle, before: readonly LedgerAction.Node[]) =>
        Effect.gen(function* () {
          const compaction = compactionIntent(before);
          expect(
            foldSessionHistory("ctx", before).map((entry: Message.WithParts) => entry.info.role),
          ).toEqual(["assistant"]);
          const outcome = yield* handle.restoreContext(compaction.id);
          expect(outcome.terminal).toBe("executed");
          const after = SessionHandleStore.tree("ctx");
          expect(after.slice(0, before.length)).toEqual([...before]);
          const appended = after.slice(before.length);
          expect(
            appended.map((action: LedgerAction.Node) => [
              action.kind,
              action.parentId,
            ]),
          ).toEqual([
            ["policy.decision", compaction.id],
            ["compaction", compaction.id],
            ["policy.decision", compaction.id],
            ["compaction", nth(appended, 1).id],
          ]);
          expect(nth(appended, 0).intent.value).toMatchObject({
            hook: "turn.post",
            op: "restore_context_projection",
          });
          expect(nth(appended, 1).intent.value).toMatchObject({
            op: "restore_context_projection",
            value: { compactionId: compaction.id },
            recovery: "local_transactional",
          });
          expect(nth(appended, 3).effect.value).toMatchObject({
            terminal: "executed",
            result: {
              restored: {
                compactionId: compaction.id,
                discarded: { count: 1 },
              },
            },
          });
          expect(
            foldSessionHistory("ctx", after).map((entry: Message.WithParts) => entry.info.role),
          ).toEqual(["user", "assistant"]);
          expect(foldSessionHistory("ctx", after)).toEqual(
            foldSessionHistory(
              "ctx",
              before.slice(0, before.indexOf(compaction)),
            ),
          );
          expect(SessionHandleStore.row("ctx").leaseOwner).toBeNull();
          expect(handle.inspect().compactions).toEqual([
            expect.objectContaining({
              compactionId: compaction.id,
              restoredBy: [nth(appended, 1).id],
            }),
          ]);
        }),
      ),
    ));

  test("a refused restoration records only the policy decision and changes nothing", () =>
    isolated(
      program(
        (handle: SessionHandle, before: readonly LedgerAction.Node[]) =>
          Effect.gen(function* () {
            const outcome = yield* handle.restoreContext(
              compactionIntent(before).id,
            );
            expect(outcome).toEqual({
              terminal: "blocked_pre",
              reason: "pinned_projection",
            });
            const after = SessionHandleStore.tree("ctx");
            expect(
              after
                .slice(before.length)
                .map((action: LedgerAction.Node) => action.kind),
            ).toEqual(["policy.decision"]);
            expect(foldSessionHistory("ctx", after)).toEqual(
              foldSessionHistory("ctx", before),
            );
          }),
        [{
          name: "no-restore", kind: "turn", phase: "post",
          match: { encodingVersion: 1, value: { op: "restore_context_projection" } },
          verdict: { encodingVersion: 1, value: { type: "deny", reason: "pinned_projection" } },
          priority: 500,
        }],
      ),
    ));

  test("an unknown or unexecuted compaction is refused before anything is recorded", () =>
    isolated(
      program((handle: SessionHandle, before: readonly LedgerAction.Node[]) =>
        Effect.gen(function* () {
          const compaction = compactionIntent(before);
          const missing = yield* Effect.exit(handle.restoreContext("nope"));
          expect(missing._tag).toBe("Failure");
          if (missing._tag === "Failure") {
            expect(Cause.squash(missing.cause)).toMatchObject({
              name: "ContextRestoreError",
              code: "context_restore_refused",
              reason: "unknown_compaction",
            });
          }
          expect(SessionHandleStore.row("ctx").leaseOwner).toBeNull();
          const result = before.find(
            (action: LedgerAction.Node) =>
              action.kind === "compaction" && action.parentId === compaction.id,
          );
          const unexecuted = yield* Effect.exit(
            handle.restoreContext(result?.id ?? ""),
          );
          expect(unexecuted._tag).toBe("Failure");
          if (unexecuted._tag === "Failure") {
            expect(Cause.squash(unexecuted.cause)).toMatchObject({
              name: "ContextRestoreError", code: "context_restore_refused", reason: "not_executed",
            });
          }
          expect(SessionHandleStore.tree("ctx")).toEqual([...before]);
          expect(SessionHandleStore.row("ctx").leaseOwner).toBeNull();
        }),
      ),
    ));
});

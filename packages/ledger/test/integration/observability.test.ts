import { sessionTree } from "../helpers/session-tree";
import { Effect, Result } from "effect";
import { describe, expect, test } from "bun:test";
import { LedgerAction, LedgerSession, type ObservationSink } from "@openomni/protocol";
import { createActions } from "../../src/storage/sqlite-l0-actions";
import type { ObservationPublishFailure } from "../../src/storage/sqlite-l0-observation";
import { createSessions } from "../../src/storage/sqlite-l0-sessions";
import { runLedgerSync } from "../helpers/effect";
import { openLedgerDatabase, observedL0Adapters } from "../helpers/ledger";

const encoded = (value: string) => ({ encodingVersion: 1 as const, value: { value } });

function session(id: string): LedgerSession.Row {
  return LedgerSession.Row.parse({
    id,
    parentId: null,
    role: "resident",
    leaseOwner: null,
    leaseFence: 0,
    revision: 0,
    state: "idle",
  });
}

function action(id: string, sessionId: string): LedgerAction.Append {
  return LedgerAction.Append.parse({
    id,
    parentId: null,
    sessionId,
    kind: "turn",
    intent: encoded("intent"),
    effect: encoded("result"),
    irreversible: true,
    ts: 100,
  });
}

function create(adapter: ReturnType<typeof observedL0Adapters>["adapter"], id: string) {
  Result.getOrThrowWith(
    runLedgerSync(Effect.result(adapter.sessions.create(session(id)))),
    (error) => error,
  );
}

describe("ledger-first observations", () => {
  test("publishes exactly one committed receipt after durable revision advances", () => {
    using db = openLedgerDatabase();
    const { adapter, observations, failures } = observedL0Adapters(db);
    create(adapter, "session-observed");

    const receipt = adapter.actions.append(action("action-observed", "session-observed"), 0);

    expect(receipt?.revision).toBe(1);
    expect(adapter.sessions.get("session-observed")?.revision).toBe(1);
    expect(observations).toEqual([
      { id: "action-observed", sessionId: "session-observed", revision: 1, kind: "turn" },
    ]);
    expect(failures).toEqual([]);
  });

  test("CAS refusal emits nothing", () => {
    using db = openLedgerDatabase();
    const { adapter, observations } = observedL0Adapters(db);
    create(adapter, "session-refused");

    expect(adapter.actions.append(action("action-refused", "session-refused"), 1)).toBeUndefined();
    expect(adapter.sessions.get("session-refused")?.revision).toBe(0);
    expect(sessionTree("session-refused", adapter.actions)).toEqual([]);
    expect(observations).toEqual([]);
  });

  test("throwing and noop sinks preserve the committed product result", () => {
    const throwing: ObservationSink = {
      publish() {
        throw new Error("sink failed");
      },
    };
    using throwingDb = openLedgerDatabase();
    using noopDb = openLedgerDatabase();
    const routedFailures: ObservationPublishFailure[] = [];
    const throwingActions = createActions(
      throwingDb,
      (operation) => throwingDb.transaction(operation).immediate(),
      throwing,
      (failure) => routedFailures.push(failure),
    );
    const noopFailures: ObservationPublishFailure[] = [];
    const noopActions = createActions(
      noopDb,
      (operation) => noopDb.transaction(operation).immediate(),
      { publish: () => undefined },
      (failure) => noopFailures.push(failure),
    );
    const { adapter: throwingSessions } = observedL0Adapters(throwingDb);
    const { adapter: noopSessions } = observedL0Adapters(noopDb);
    create(throwingSessions, "session-parity");
    create(noopSessions, "session-parity");

    const withThrow = throwingActions.append(action("action-parity", "session-parity"), 0);
    const withNoop = noopActions.append(action("action-parity", "session-parity"), 0);

    expect(withThrow).toEqual(withNoop);
    expect(routedFailures).toEqual([{ actionId: "action-parity", cause: new Error("sink failed") }]);
    expect(noopFailures).toEqual([]);
    expect(sessionTree("session-parity", throwingActions)).toEqual(
      sessionTree("session-parity", noopActions),
    );
  });

  test("a throwing failure port never unwinds a committed append or commit", () => {
    const throwing: ObservationSink = {
      publish() {
        throw new Error("sink failed");
      },
    };
    const port = (): never => {
      throw new Error("reporter failed");
    };
    using db = openLedgerDatabase();
    const transaction = <T,>(operation: () => T): T => db.transaction(operation).immediate();
    const actions = createActions(db, transaction, throwing, port);
    const sessions = createSessions(db, transaction, throwing, port);
    runLedgerSync(sessions.create(session("session-ported")));

    const appended = actions.append(action("action-appended", "session-ported"), 0);
    expect(appended?.revision).toBe(1);
    runLedgerSync(sessions.adoptFence({ sessionId: "session-ported", owner: "writer", fence: 1 }));
    const committed = runLedgerSync(
      sessions.commit({
        sessionId: "session-ported",
        owner: "writer",
        fence: 1,
        now: 101,
        expectedRevision: 1,
        actions: [{ ...action("action-committed", "session-ported"), parentId: "action-appended" }],
        state: "running",
      }),
    );

    expect(committed.receipts.map((receipt) => receipt.action.id)).toEqual(["action-committed"]);
    expect(sessionTree("session-ported", actions).map((node) => node.id)).toEqual([
      "action-appended",
      "action-committed",
    ]);
  });
});

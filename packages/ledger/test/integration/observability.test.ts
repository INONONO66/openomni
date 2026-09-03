import { afterEach, describe, expect, test } from "bun:test";
import {
  Alarm,
  Inbox,
  LedgerAction,
  LedgerSession,
  L0Observation,
  type ObservationSink,
} from "@openomni/protocol";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage.js";

const encoded = (value: string) => ({ encodingVersion: 1 as const, value: { value } });

function session(id: string): LedgerSession.Row {
  return LedgerSession.Row.parse({
    id,
    parentId: null,
    role: "resident",
    leaseOwner: null,
    leaseFence: 0,
    leaseExpiresAt: null,
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

const adapters: SqliteStorageAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.close();
});

describe("ledger-first observations", () => {
  test("publishes exactly one committed receipt after durable revision advances", () => {
    const observations: L0Observation.ActionCommitted[] = [];
    let adapter!: SqliteStorageAdapter;
    const sink: ObservationSink = {
      publish(descriptor, data) {
        if (descriptor.name !== L0Observation.ActionCommittedEvent.name) return;
        observations.push(L0Observation.ActionCommitted.parse(data));
        expect(adapter.sessions.get("session-observed")?.revision).toBe(1);
      },
    };
    adapter = new SqliteStorageAdapter(":memory:", sink);
    adapters.push(adapter);
    adapter.sessions.create(session("session-observed"));

    const receipt = adapter.actions.append(action("action-observed", "session-observed"), 0);

    expect(receipt?.revision).toBe(1);
    expect(observations).toEqual([
      { id: "action-observed", sessionId: "session-observed", revision: 1, kind: "turn" },
    ]);
  });

  test("inbox commit and alarm arm each publish their committed action", () => {
    const observations: L0Observation.ActionCommitted[] = [];
    const sink: ObservationSink = {
      publish(descriptor, data) {
        if (descriptor.name === L0Observation.ActionCommittedEvent.name) {
          observations.push(L0Observation.ActionCommitted.parse(data));
        }
      },
    };
    const adapter = new SqliteStorageAdapter(":memory:", sink);
    adapters.push(adapter);
    adapter.sessions.create(session("session-surfaces"));

    expect(
      adapter.inbox.commit(
        Inbox.Commit.parse({
          id: "inbox-observed",
          sessionId: "session-surfaces",
          kind: "prompt",
          content: "go",
          origin: encoded("owner"),
          createdAt: 101,
        }),
      ),
    ).toBeDefined();
    expect(
      adapter.alarms.arm(
        Alarm.Arm.parse({
          id: "alarm-observed",
          sessionId: "session-surfaces",
          kind: "at",
          fireAt: 102,
        }),
      ),
    ).toBeDefined();

    expect(observations).toEqual([
      { id: "inbox-observed", sessionId: "session-surfaces", revision: 1, kind: "prompt" },
      { id: "alarm-observed", sessionId: "session-surfaces", revision: 2, kind: "alarm.arm" },
    ]);
    expect(adapter.sessions.get("session-surfaces")?.revision).toBe(2);
    expect(adapter.actions.tree("session-surfaces").map((node) => node.id)).toEqual([
      "inbox-observed",
      "alarm-observed",
    ]);
  });

  test("CAS refusal emits nothing", () => {
    const observations: L0Observation.ActionCommitted[] = [];
    const sink: ObservationSink = {
      publish(descriptor, data) {
        if (descriptor.name === L0Observation.ActionCommittedEvent.name) {
          observations.push(L0Observation.ActionCommitted.parse(data));
        }
      },
    };
    const adapter = new SqliteStorageAdapter(":memory:", sink);
    adapters.push(adapter);
    adapter.sessions.create(session("session-refused"));

    expect(adapter.actions.append(action("action-refused", "session-refused"), 1)).toBeUndefined();
    expect(adapter.sessions.get("session-refused")?.revision).toBe(0);
    expect(adapter.actions.tree("session-refused")).toEqual([]);
    expect(observations).toEqual([]);
  });

  test("throwing and noop sinks preserve the committed product result", () => {
    const throwing: ObservationSink = {
      publish() {
        throw new Error("sink failed");
      },
    };
    const throwingAdapter = new SqliteStorageAdapter(":memory:", throwing);
    const noopAdapter = new SqliteStorageAdapter(":memory:", { publish: () => undefined });
    adapters.push(throwingAdapter, noopAdapter);
    throwingAdapter.sessions.create(session("session-parity"));
    noopAdapter.sessions.create(session("session-parity"));

    const withThrow = throwingAdapter.actions.append(action("action-parity", "session-parity"), 0);
    const withNoop = noopAdapter.actions.append(action("action-parity", "session-parity"), 0);

    expect(withThrow).toEqual(withNoop);
    expect(throwingAdapter.actions.tree("session-parity")).toEqual(
      noopAdapter.actions.tree("session-parity"),
    );
  });
});

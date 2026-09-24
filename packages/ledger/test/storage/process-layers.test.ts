import { sessionTree } from "../helpers/session-tree";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { runLedgerSync } from "../helpers/effect";
import { L0Observation } from "@openomni/protocol";
import * as Ledger from "../../src";

test("borrowed LedgerLive consumes the supplied adapter without closing it", () => {
  const storage = new Ledger.SqliteStorageAdapter(":memory:");
  const close = spyOn(storage, "close");
  try {
    const writes = runLedgerSync(
      Ledger.LedgerWrites.pipe(Effect.provide(Ledger.LedgerLive(storage))),
    );
    expect(writes.sessions).toBe(storage.sessions);
    expect(writes.inbox).toBe(storage.inbox);
    expect(writes.alarms).toBe(storage.alarms);
    expect(close).not.toHaveBeenCalled();
    expect(writes.sessions.list()).toEqual([]);
  } finally {
    close.mockRestore();
    storage.close();
  }
});

test.each([
  false,
  true,
])("owning storage closes once after dependent cleanup (failed boot: %s)", (fail) =>
  Ledger.Storage.withIsolation(() => {
    const events: string[] = [];
    const close = spyOn(Ledger.SqliteStorageAdapter.prototype, "close");
    const dependent = Layer.scopedDiscard(
      Effect.gen(function* () {
        const writes = yield* Ledger.LedgerWrites;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            expect(close).not.toHaveBeenCalled();
            expect(writes.sessions.list()).toEqual([]);
            events.push("dependent.closed");
          }),
        );
        if (fail) return yield* Effect.fail("boot.refused");
      }),
    );
    try {
      const exit = runLedgerSync(
        Effect.exit(Effect.void.pipe(
          Effect.provide(
            dependent.pipe(Layer.provide(Ledger.LedgerStorageLive({ dbPath: ":memory:" }))),
          ),
        )),
      );
      if (fail) {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.failureOption(exit.cause)).toEqual(Option.some("boot.refused"));
      } else {
        expect(exit).toEqual(Exit.succeed(undefined));
      }
      expect(events).toEqual(["dependent.closed"]);
      expect(close).toHaveBeenCalledTimes(1);
      expect(Ledger.Storage.getInitializedDbPath()).toBeNull();
      expect(() => Ledger.Storage.get()).toThrow();
    } finally {
      close.mockRestore();
      Ledger.Storage.reset();
    }
  }));

test("owning storage publishes committed observations and rolls back a late CAS refusal", () =>
  Ledger.Storage.withIsolation(() => {
    const observed: L0Observation.ActionCommitted[] = [];
    runLedgerSync(
      Effect.gen(function* () {
        const writes = yield* Ledger.LedgerWrites;
        yield* Ledger.SessionHandleStore.materialize({
          id: "owned",
          parentId: null,
          role: "resident",
          tools: [],
          system: { preset: "", blocks: [] },
          policyGeneration: 0,
          actionId: "create",
          at: 1,
        });
        expect(Ledger.Storage.get().sessions).toBe(writes.sessions);
        yield* writes.sessions.acquireLease({
          sessionId: "owned",
          owner: "writer",
          expectedFence: 0,
          now: 2,
          expiresAt: 100,
        });
        const storage = Ledger.Storage.get();
        if (!(storage instanceof Ledger.SqliteStorageAdapter)) throw new Error("Expected SQLite");
        const before = storage.sessions.get("owned");
        storage
          .testDatabase()
          .run(
            "CREATE TRIGGER refuse_state BEFORE UPDATE OF state ON session BEGIN SELECT RAISE(IGNORE); END",
          );
        expect(
          yield* Effect.flip(
            writes.sessions.commit({
              sessionId: "owned",
              owner: "writer",
              fence: 1,
              now: 3,
              expectedRevision: 1,
              actions: [
                {
                  id: "refused",
                  sessionId: "owned",
                  parentId: "create",
                  kind: "turn",
                  intent: { encodingVersion: 1, value: { phase: "intent" } },
                  effect: { encodingVersion: 1, value: { phase: "pending" } },
                  irreversible: true,
                  ts: 3,
                },
              ],
              consumeInboxIds: [],
              state: "running",
              releaseLease: false,
            }),
          ),
        ).toMatchObject({ _tag: "CommitRefused", reason: "fence" });
        expect(storage.sessions.get("owned")).toEqual(before);
        expect(sessionTree("owned", storage.actions).map((action) => action.id)).toEqual(["create"]);
        expect(observed.map((event) => event.id)).toEqual(["create"]);
      }).pipe(
        Effect.provide(
          Ledger.LedgerStorageLive({
            dbPath: ":memory:",
            observationSink: {
              publish(event, payload) {
                if (event.name === L0Observation.ActionCommittedEvent.name)
                  observed.push(L0Observation.ActionCommitted.parse(payload));
              },
            },
          }),
        ),
      ),
    );
  }));

test("opening an invalid database fails in the ledger error channel", () =>
  Ledger.Storage.withIsolation(() => {
    const directory = mkdtempSync(join(tmpdir(), "ledger-open-refusal-"));
    try {
      const error = runLedgerSync(
        Effect.flip(
          Ledger.LedgerWrites.pipe(Effect.provide(Ledger.LedgerStorageLive({ dbPath: directory }))),
        ),
      );
      expect(error).toMatchObject({ _tag: "ForeignFailure", operation: "ledger.open" });
      if (error._tag !== "ForeignFailure") throw error;
      expect(error.cause.length).toBeGreaterThan(0);
      expect(Ledger.Storage.getInitializedDbPath()).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }));

test("a failed close is surfaced as a ledger lifecycle defect", () =>
  Ledger.Storage.withIsolation(() => {
    const close = spyOn(Ledger.SqliteStorageAdapter.prototype, "close").mockImplementation(() => {
      throw new Error("close-refused");
    });
    try {
      const exit = runLedgerSync(
        Effect.exit(Ledger.LedgerWrites.pipe(Effect.provide(Ledger.LedgerStorageLive({ dbPath: ":memory:" })))),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(Cause.dieOption(exit.cause)).toEqual(
          Option.some(
            new Ledger.ForeignFailure({ operation: "ledger.close", cause: "Error: close-refused" }),
          ),
        );
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      Ledger.Storage.reset();
    }
  }));

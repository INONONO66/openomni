import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { armAction, firedAction, type AlarmCapability } from "../src/core/alarm";
import { openCatalogStore } from "../src/core/store/catalog";
import { CatalogVersionRefused, type LedgerError } from "../src/core/store/errors";
import { openSessionStore } from "../src/core/store/session-file";
import * as SessionHandleStore from "../src/core/store/fence";
import {
  clusterTempDir,
  readChain,
  runCluster,
  sendAlarm,
  sessionFileFor,
  type TestClusterOptions,
} from "./helpers/cluster-runtime";
import { runAgent } from "./helpers/executor";

// #1254 S3: scheduling that survives a crash. The arm row's commit maintains
// the session file's `armed_alarms` index in the SAME transaction; the catalog
// `has_armed` flag is 1 before the arming commit and 0 only after the index is
// confirmed empty; an activation resends every armed row's ORIGINAL occurrence
// so the cluster's DeliverAt door (occurrence id = dedupe key) re-fires it.

const { dir, sessionsDir, catalogFile } = clusterTempDir("alarm-recovery-");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PAST_FIRE_AT = 1_000;

/** Post-run assertions over fresh read handles (no materialize, no fence). */
async function readSession(
  sessionId: string,
  use: (input: {
    readonly catalog: ReturnType<typeof openCatalogStore>;
    readonly kernel: SessionHandleStore.SessionKernel;
  }) => Promise<void> | void,
): Promise<void> {
  const catalog = openCatalogStore(catalogFile, { now: () => 1 });
  const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
  try {
    await use({ catalog, kernel: SessionHandleStore.createSessionKernel(store, catalog) });
  } finally {
    store.close();
    catalog.close();
  }
}

/** Materialize + index one session, run `arm` inside a short-lived handle pair. */
async function withSession(
  sessionId: string,
  use: (input: {
    readonly catalog: ReturnType<typeof openCatalogStore>;
    readonly store: ReturnType<typeof openSessionStore>;
    readonly kernel: SessionHandleStore.SessionKernel;
    readonly commit: (
      actions: readonly ReturnType<typeof firedAction>[],
    ) => Promise<Result.Result<unknown, LedgerError>>;
  }) => Promise<void>,
): Promise<void> {
  const catalog = openCatalogStore(catalogFile, { now: () => 1 });
  const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
  const kernel = SessionHandleStore.createSessionKernel(store, catalog);
  try {
    catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
    await runAgent(
      kernel.materialize({
        id: sessionId,
        parentId: null,
        role: "resident",
        tools: [],
        system: { preset: "", blocks: [] },
        policyGeneration: 1,
        actionId: `${sessionId}:materialize`,
        at: 1,
      }),
    );
    const adoption = await runAgent(kernel.adoptFence({ sessionId, owner: "arm-writer", fence: 1 }));
    const commit = (actions: readonly ReturnType<typeof firedAction>[]) =>
      runAgent(
        Effect.result(
          kernel.commit({
            sessionId,
            owner: "arm-writer",
            fence: adoption.fence,
            now: 2,
            expectedRevision: kernel.row(sessionId).revision,
            actions: [...actions],
            state: "idle",
          }),
        ),
      );
    await use({ catalog, store, kernel, commit });
  } finally {
    store.close();
    catalog.close();
  }
}

function arm(sessionId: string, alarmId: string, armSeq: number, at: number | null, supersedes: string | null = null) {
  return armAction({
    parentId: null,
    sessionId,
    purpose: "note.due",
    at,
    supersedes,
    alarmId,
    sourceKey: "note",
    payload: { note: `${alarmId}@${armSeq}` },
    armSeq,
    ts: 2,
  });
}

describe("armed_alarms index in the append transaction", () => {
  test("arm upserts, retire deletes, fired deletes — all visible through the kernel reads", async () => {
    const sessionId = "idx-lifecycle";
    await withSession(sessionId, async ({ kernel, commit, catalog }) => {
      const first = arm(sessionId, "a1", 1, PAST_FIRE_AT);
      expect(Result.isSuccess(await commit([first.action]))).toBe(true);
      expect(kernel.armedCount()).toBe(1);
      expect(kernel.armedAlarms()).toEqual([
        {
          alarmId: "a1",
          occurrenceId: first.occurrenceId,
          fireAt: PAST_FIRE_AT,
          purpose: "note.due",
          armSeq: 1,
          sourceKey: "note",
          payload: JSON.stringify({ note: "a1@1" }),
        },
      ]);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(true);

      // Re-arm supersedes in place: still one row, now the new occurrence.
      const second = arm(sessionId, "a1", 2, PAST_FIRE_AT + 1, first.occurrenceId);
      expect(Result.isSuccess(await commit([second.action]))).toBe(true);
      expect(kernel.armedAlarms().map((row) => row.occurrenceId)).toEqual([second.occurrenceId]);

      // A stale firing of the OLD occurrence touches nothing (deletes by its
      // occurrence id, which no longer indexes a row); has_armed stays 1.
      const stale = firedAction({
        parentId: null,
        sessionId,
        purpose: "note.due",
        alarmId: "a1",
        occurrenceId: first.occurrenceId,
        outcome: "stale",
        ts: 2,
      });
      expect(Result.isSuccess(await commit([stale]))).toBe(true);
      expect(kernel.armedAlarms().map((row) => row.occurrenceId)).toEqual([second.occurrenceId]);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(true);

      // The delivered firing of the live occurrence empties the index and only
      // then clears has_armed.
      const delivered = firedAction({
        parentId: null,
        sessionId,
        purpose: "note.due",
        alarmId: "a1",
        occurrenceId: second.occurrenceId,
        outcome: "delivered",
        ts: 2,
      });
      expect(Result.isSuccess(await commit([delivered]))).toBe(true);
      expect(kernel.armedCount()).toBe(0);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(false);

      // Retire (arm at: null) deletes by alarm id.
      const third = arm(sessionId, "a1", 3, PAST_FIRE_AT);
      expect(Result.isSuccess(await commit([third.action]))).toBe(true);
      expect(kernel.armedCount()).toBe(1);
      const retire = arm(sessionId, "a1", 4, null, third.occurrenceId);
      expect(Result.isSuccess(await commit([retire.action]))).toBe(true);
      expect(kernel.armedCount()).toBe(0);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(false);
    });
  });

  test("same transaction: a refused later row rolls back the arm AND its index write", async () => {
    const sessionId = "idx-rollback";
    await withSession(sessionId, async ({ kernel, commit }) => {
      const revisionBefore = kernel.row(sessionId).revision;
      const armed = arm(sessionId, "a-roll", 1, PAST_FIRE_AT);
      // A second alarm row with a schema-invalid op refuses the whole batch
      // (a constructor-built row with its intent corrupted in memory: the
      // store's write-side schema check is the subject here, not the writer).
      const invalid = {
        ...arm(sessionId, "a-roll-invalid", 1, PAST_FIRE_AT).action,
        intent: { encodingVersion: 1 as const, value: { op: "explode" } },
      };
      const result = await commit([armed.action, invalid]);
      expect(Result.isFailure(result)).toBe(true);
      expect(kernel.armedCount()).toBe(0);
      expect(kernel.row(sessionId).revision).toBe(revisionBefore);
      expect(kernel.actionById("a-roll:arm:1")).toBeUndefined();
    });
  });

  test("has_armed is 1 BEFORE the arming commit lands: a refused commit leaves the flag up", async () => {
    const sessionId = "idx-flag-first";
    await withSession(sessionId, async ({ kernel, catalog }) => {
      const armed = arm(sessionId, "a-flag", 1, PAST_FIRE_AT);
      const refused = await runAgent(
        Effect.result(
          kernel.commit({
            sessionId,
            owner: "someone-else", // not the fence owner: the commit itself refuses
            fence: 999,
            now: 2,
            expectedRevision: kernel.row(sessionId).revision,
            actions: [armed.action],
            state: "idle",
          }),
        ),
      );
      expect(Result.isFailure(refused)).toBe(true);
      // The journal shows no arm, yet the catalog intent was already durable:
      // exactly the crash window the boot rescan exists for.
      expect(kernel.actionById("a-flag:arm:1")).toBeUndefined();
      expect(kernel.armedCount()).toBe(0);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(true);
    });
  });
});

describe("catalog schema v2 (has_armed)", () => {
  test("a v1 catalog upgrades in place: column added, marker bumped, rows intact", () => {
    const directory = mkdtempSync(join(tmpdir(), "catalog-v1-"));
    const path = join(directory, "catalog.sqlite");
    try {
      const v1 = new Database(path);
      v1.run(`CREATE TABLE session_index (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('resident', 'worker')),
        fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
        created_at INTEGER NOT NULL
      )`);
      v1.run(
        "INSERT INTO session_index (id, parent_id, role, fence, created_at) VALUES ('s-old', NULL, 'resident', 3, 7)",
      );
      v1.run("PRAGMA user_version = 1");
      v1.close();

      const store = openCatalogStore(path, { now: () => 1 });
      try {
        expect(store.sessionIndex("s-old")).toEqual({
          id: "s-old",
          parentId: null,
          role: "resident",
          fence: 3,
          createdAt: 7,
          hasArmed: false,
        });
        store.markArmed("s-old", true);
        expect(store.armedSessionIds()).toEqual(["s-old"]);
        store.markArmed("s-old", false);
        expect(store.armedSessionIds()).toEqual([]);
      } finally {
        store.close();
      }
      const reopened = new Database(path, { readonly: true });
      try {
        expect(reopened.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  test("a newer (v3) catalog opens read-only: markArmed refuses typed", () => {
    const directory = mkdtempSync(join(tmpdir(), "catalog-v3-"));
    const path = join(directory, "catalog.sqlite");
    try {
      const created = openCatalogStore(path, { now: () => 1 });
      created.close();
      const stamped = new Database(path);
      stamped.run("PRAGMA user_version = 3");
      stamped.close();

      const reopened = openCatalogStore(path, { now: () => 1 });
      try {
        let refusal: unknown;
        try {
          reopened.markArmed("s-any", true);
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toBeInstanceOf(CatalogVersionRefused);
        if (refusal instanceof CatalogVersionRefused) {
          expect(refusal.operation).toBe("markArmed");
          expect(refusal.fileVersion).toBe(3);
          expect(refusal.codeVersion).toBe(2);
        }
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});

// ─── crash → activation resend, through the real cluster door ───

const RESEND_TIMEOUT_MS = 15_000;

/**
 * #1254 S4: non-reserved purposes dispatch to the composed capability; an
 * unbound purpose folds stale. These recovery tests pin the RESEND path, so
 * the `note.due` purpose is registered with a wake that just accepts.
 */
const noteCapability: AlarmCapability = {
  purposes: ["note.due"],
  wake: () => Effect.succeed("delivered" as const),
};

function resendSignal(): {
  readonly options: Pick<TestClusterOptions, "onAlarmResend">;
  readonly delivered: (occurrenceId: string) => Promise<void>;
} {
  const seen = new Map<string, () => void>();
  const settled = new Set<string>();
  return {
    options: {
      onAlarmResend: (_sessionId, occurrence, receipt) => {
        if (receipt.outcome !== "delivered") return;
        settled.add(occurrence.occurrenceId);
        seen.get(occurrence.occurrenceId)?.();
      },
    },
    delivered: (occurrenceId) =>
      new Promise<void>((resolve, reject) => {
        if (settled.has(occurrenceId)) return resolve();
        seen.set(occurrenceId, resolve);
        setTimeout(
          () => reject(new Error(`timed out waiting for resend of ${occurrenceId}`)),
          RESEND_TIMEOUT_MS,
        ).unref?.();
      }),
  };
}

function firedRows(sessionId: string, occurrenceId: string): Record<string, number> {
  const rows = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  return {
    delivered: rows.filter((row) => row.id === `${occurrenceId}:delivered`).length,
    stale: rows.filter((row) => row.id === `${occurrenceId}:stale`).length,
  };
}

describe("crash recovery through the cluster", () => {
  test("crash after arm, before DeliverAt: the rescan wake resends and exactly one fired{delivered} lands", async () => {
    const sessionId = "crash-resend";
    let occurrenceId = "";
    // Phase 1 — the pre-crash world: arm committed, process gone before the
    // cluster ever saw the occurrence.
    await withSession(sessionId, async ({ commit }) => {
      const armed = arm(sessionId, "due-1", 1, PAST_FIRE_AT);
      occurrenceId = armed.occurrenceId;
      expect(Result.isSuccess(await commit([armed.action]))).toBe(true);
    });

    // Phase 2 — boot: the sweep's rescan occurrence wakes the entity; the
    // activation resend re-fires the original occurrence.
    const signal = resendSignal();
    await runCluster(
      { sessionsDir, catalogFile, alarmCapability: noteCapability, ...signal.options },
      Effect.gen(function* () {
        const receipt = yield* sendAlarm(sessionId, {
          occurrenceId: `${sessionId}:rescan:boot-1`,
          purpose: "rescan",
          alarmId: `${sessionId}:rescan`,
          armSeq: 0,
          sourceKey: "rescan",
          payload: "{}",
          fireAt: PAST_FIRE_AT,
        });
        expect(receipt.outcome).toBe("delivered");
        yield* Effect.promise(() => signal.delivered(occurrenceId));
        // Bounded termination: once the index is empty a second sweep's wake
        // converges — it replies delivered, resends nothing, appends nothing
        // (the chain census below pins the zero-effect claim).
        const second = yield* sendAlarm(sessionId, {
          occurrenceId: `${sessionId}:rescan:boot-1b`,
          purpose: "rescan",
          alarmId: `${sessionId}:rescan`,
          armSeq: 0,
          sourceKey: "rescan",
          payload: "{}",
          fireAt: PAST_FIRE_AT,
        });
        expect(second.outcome).toBe("delivered");
      }),
    );

    expect(firedRows(sessionId, occurrenceId)).toEqual({ delivered: 1, stale: 0 });
    const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
    // The rescan wake itself appended nothing.
    expect(chain.filter((row) => row.id.includes(":rescan"))).toHaveLength(0);
    await readSession(sessionId, ({ kernel, catalog }) => {
      expect(kernel.armedCount()).toBe(0);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(false);
    });
  }, 30_000);

  test("resend is bounded: N armed rows resend exactly N occurrences, once per activation", async () => {
    const sessionId = "crash-resend-bounded";
    const occurrences: string[] = [];
    await withSession(sessionId, async ({ commit }) => {
      for (const alarmId of ["due-n1", "due-n2", "due-n3"]) {
        const armed = arm(sessionId, alarmId, 1, PAST_FIRE_AT);
        occurrences.push(armed.occurrenceId);
        expect(Result.isSuccess(await commit([armed.action]))).toBe(true);
      }
    });

    const resends: string[] = [];
    const signal = resendSignal();
    await runCluster(
      {
        sessionsDir,
        catalogFile,
        alarmCapability: noteCapability,
        onAlarmResend: (innerSessionId, occurrence, receipt) => {
          resends.push(occurrence.occurrenceId);
          signal.options.onAlarmResend?.(innerSessionId, occurrence, receipt);
        },
      },
      Effect.gen(function* () {
        yield* sendAlarm(sessionId, {
          occurrenceId: `${sessionId}:rescan:boot-n`,
          purpose: "rescan",
          alarmId: `${sessionId}:rescan`,
          armSeq: 0,
          sourceKey: "rescan",
          payload: "{}",
          fireAt: PAST_FIRE_AT,
        });
        for (const occurrenceId of occurrences) {
          yield* Effect.promise(() => signal.delivered(occurrenceId));
        }
        // A second rescan on the SAME activation resends nothing: the resend
        // ran exactly once and every delivered row already left the index.
        const second = yield* sendAlarm(sessionId, {
          occurrenceId: `${sessionId}:rescan:boot-n2`,
          purpose: "rescan",
          alarmId: `${sessionId}:rescan`,
          armSeq: 0,
          sourceKey: "rescan",
          payload: "{}",
          fireAt: PAST_FIRE_AT,
        });
        expect(second.outcome).toBe("delivered");
      }),
    );

    // Exactly N resends — not N per rescan, not a self-retriggering storm.
    expect([...resends].sort()).toEqual([...occurrences].sort());
    for (const occurrenceId of occurrences) {
      expect(firedRows(sessionId, occurrenceId)).toEqual({ delivered: 1, stale: 0 });
    }
    await readSession(sessionId, ({ kernel, catalog }) => {
      expect(kernel.armedCount()).toBe(0);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(false);
    });
  }, 30_000);

  test("supersede then crash: the new occurrence fires, the late old one folds stale with zero execution", async () => {

    const sessionId = "crash-supersede";
    let oldOccurrence = "";
    let newOccurrence = "";
    await withSession(sessionId, async ({ commit }) => {
      const first = arm(sessionId, "due-2", 1, PAST_FIRE_AT);
      oldOccurrence = first.occurrenceId;
      expect(Result.isSuccess(await commit([first.action]))).toBe(true);
      const second = arm(sessionId, "due-2", 2, PAST_FIRE_AT + 1, first.occurrenceId);
      newOccurrence = second.occurrenceId;
      expect(Result.isSuccess(await commit([second.action]))).toBe(true);
    });

    const signal = resendSignal();
    await runCluster(
      { sessionsDir, catalogFile, alarmCapability: noteCapability, ...signal.options },
      Effect.gen(function* () {
        yield* sendAlarm(sessionId, {
          occurrenceId: `${sessionId}:rescan:boot-2`,
          purpose: "rescan",
          alarmId: `${sessionId}:rescan`,
          armSeq: 0,
          sourceKey: "rescan",
          payload: "{}",
          fireAt: PAST_FIRE_AT,
        });
        yield* Effect.promise(() => signal.delivered(newOccurrence));
        // The old occurrence arrives late (it was never registered before the
        // crash): the chain guard folds it to a recorded stale fact.
        const late = yield* sendAlarm(sessionId, {
          occurrenceId: oldOccurrence,
          purpose: "note.due",
          alarmId: "due-2",
          armSeq: 1,
          sourceKey: "note",
          payload: JSON.stringify({ note: "due-2@1" }),
          fireAt: PAST_FIRE_AT,
        });
        expect(late.outcome).toBe("stale");
      }),
    );

    expect(firedRows(sessionId, newOccurrence)).toEqual({ delivered: 1, stale: 0 });
    expect(firedRows(sessionId, oldOccurrence)).toEqual({ delivered: 0, stale: 1 });
    await readSession(sessionId, ({ kernel, catalog }) => {
      expect(kernel.armedCount()).toBe(0);
      expect(catalog.sessionIndex(sessionId)?.hasArmed).toBe(false);
    });
  }, 30_000);
});

/**
 * #1254 S4: a capability arm commits through the entity's commit door, and the
 * minted occurrence is forwarded to DeliverAt from the committed row itself
 * (not from the index the activation resend reads). Its `payload` must be the
 * arm's canonical JSON bytes — a non-empty payload, because `{}` serializes
 * identically under every profile and hides a wrong serializer.
 */
describe("live arm forward through the cluster", () => {
  test("ctx.arm's forwarded occurrence carries the arm payload as parseable canonical JSON", async () => {
    const sessionId = "live-forward";
    await withSession(sessionId, async ({ commit }) => {
      expect(Result.isSuccess(await commit([arm(sessionId, "seed", 1, PAST_FIRE_AT).action]))).toBe(true);
    });
    const payloads: string[] = [];
    let resolveChained: () => void = () => undefined;
    const chained = new Promise<void>((resolve) => {
      resolveChained = resolve;
    });
    const capability: AlarmCapability = {
      purposes: ["note.due"],
      wake: (fired, ctx) =>
        Effect.gen(function* () {
          payloads.push(fired.payload);
          if (fired.alarmId === "seed") {
            yield* ctx.arm({
              purpose: "note.due",
              at: ctx.now - 1,
              payload: { note: "live", attempt: 2, tags: ["z", "a"] },
              sourceKey: "note",
              alarmId: "chained",
            }).pipe(Effect.orDie);
          } else resolveChained();
          return "delivered" as const;
        }),
    };
    await runCluster(
      { sessionsDir, catalogFile, alarmCapability: capability },
      Effect.gen(function* () {
        yield* sendAlarm(sessionId, {
          occurrenceId: "kick",
          purpose: "rescan",
          alarmId: "kick",
          armSeq: 1,
          sourceKey: "rescan",
          payload: "{}",
          fireAt: Date.now() - 1,
        });
        yield* Effect.promise(() => chained);
      }),
    );
    expect(payloads.map((payload) => JSON.parse(payload))).toEqual([
      { note: "seed@1" },
      { note: "live", attempt: 2, tags: ["z", "a"] },
    ]);
    expect(payloads[1]).toBe('{"attempt":2,"note":"live","tags":["z","a"]}');
  });
});

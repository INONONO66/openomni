import { sessionTree } from "../../../packages/ledger/test/helpers/session-tree";
import { Effect, Either } from "effect";
import { runEffect, runSyncEffect } from "./helpers/effect";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHandleStore, SqliteStorageAdapter, Storage } from "@openomni/ledger";
import { Alarm } from "@openomni/protocol";
import type { RunInput, Sink } from "@openomni/llm";
import { assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";
import { alarmFixture } from "./helpers/alarm";

const suite = residentSuite();

test("fresh app boot repairs fire committed before wake exactly once without refiring", async () => {
  const config = suite.config("alarm-doorbell-");
  let calls = 0;
  const options = {
    config,
    sessionRuntime: { clock: () => 100 },
    llm: {
      resolveModel: fakeProviderModel,
      run: (input: RunInput, sink: Sink) => Effect.sync(() => {
        calls += 1;
        sink.onMessage(assistantMessage(input, { text: "DOORBELL_SENTINEL" }));
        return { type: "stop" as const };
      }),
    },
  };
  const first = await suite.boot(options);
  const terminal = nextResidentTurn();
  const receipt = await runEffect(first.gateway.ingest(
    { kind: "external", surface: "ws", externalId: "owner" },
    { eventId: "seed", surface: "ws", channelId: "owner", dm: true, addressees: [], payload: "seed", render: "seed" },
  ));
  if (receipt.status !== "executed") throw new Error("seed refused");
  await terminal;
  const sessionId = receipt.handle.target;
  await first.stop();

  // Simulate the crash cut: the real transaction commits, but no runtime exists
  // to receive the in-memory doorbell. Close SQLite and build a fresh AppLive.
  const storage = new SqliteStorageAdapter(config.dbPath);
  Storage.configure(storage);
  const armed = await runEffect(storage.alarms.arm({
    id: "doorbell", sessionId, kind: "at", fireAt: 100,
    spec: { encodingVersion: 1, value: "WAKE_SENTINEL" },
  }));
  const owned = await runEffect(storage.alarms.acquire(armed.id, armed.fence));
  const fire = {
    id: owned.id, epoch: owned.epoch, fence: owned.fence,
    sourceKey: "timer:100", at: 100, content: "WAKE_SENTINEL", terminal: true,
  };
  const fired = await runEffect(storage.alarms.fire(fire));
  const occurrenceId = Alarm.occurrenceId(owned.id, owned.epoch, fire.sourceKey);
  expect(sessionTree(sessionId).find((action) => action.id === fired.inbox.id)?.parentId).toBe(occurrenceId);
  expect(SessionHandleStore.pendingInbox(sessionId)).toHaveLength(1);
  expect(storage.alarms.due(100)).toEqual([]);
  const promptIds = sessionTree(sessionId).filter((action) => action.kind === "prompt").map((action) => action.id);
  const occurrence = sessionTree(sessionId).find((action) => action.id === occurrenceId);
  expect(occurrence?.intent.value).toMatchObject({ epoch: owned.epoch, fence: owned.fence, sourceKey: fire.sourceKey });
  Storage.reset();

  calls = 0;
  const fresh = await suite.boot(options);
  expect(calls).toBe(1);
  expect(SessionHandleStore.pendingInbox(sessionId)).toEqual([]);
  expect(SessionHandleStore.inboxRows(sessionId).find((row) => row.id === fired.inbox.id)?.status).toBe("consumed");
  expect(sessionTree(sessionId).filter((action) => action.kind === "prompt").map((action) => action.id)).toEqual(promptIds);
  expect(sessionTree(sessionId).filter((action) => action.kind === "alarm.fired")).toHaveLength(1);
  expect(sessionTree(sessionId).find((action) => action.id === occurrenceId)).toEqual(occurrence);
  const reopenedAlarms = Storage.get().alarms;
  if (reopenedAlarms === undefined) throw new Error("missing alarm storage");
  expect(await runEffect(Effect.flip(reopenedAlarms.fire(fire)))).toMatchObject({
    _tag: "AlarmRefused", reason: "occurrence",
  });
  await fresh.stop();
  const again = await suite.boot(options);
  expect(calls).toBe(1);
  expect(sessionTree(sessionId).filter((action) => action.kind === "prompt").map((action) => action.id)).toEqual(promptIds);
  await again.stop();
});

test("alarm restart: SQLite reopen fires at the exact boundary with atomic prompt truth", () =>
  Storage.withIsolation(async () => {
    const directory = mkdtempSync(join(tmpdir(), "alarm-reopen-"));
    const database = join(directory, "ledger.db");
    let fixture = alarmFixture(database);
    try {
      Either.getOrThrowWith(
        runSyncEffect(
          Effect.either(
            fixture.storage.alarms.arm({
              id: "at",
              sessionId: "monitor-session",
              kind: "at",
              fireAt: 2000,
              spec: { encodingVersion: 1, value: "deadline" },
            }),
          ),
        ),
        (error) => error,
      );
      await fixture.close();
      fixture = alarmFixture(database);
      fixture.advance(1999);
      await runEffect(fixture.worker.start());
      expect(fixture.rows()).toEqual([]);
      const fired = fixture.next("at");
      fixture.advance(2000);
      await runEffect(fixture.worker.tick());
      const prompt = await fired;
      expect(prompt).toMatchObject({
        origin: { value: "at" },
        content: "deadline",
        createdAt: 2000,
      });
      const tree = sessionTree("monitor-session", fixture.storage.actions);
      expect(tree.map((action) => action.kind)).toEqual(["alarm.arm", "alarm.fired", "prompt"]);
      expect(tree.at(-1)?.ordinal).toBe(fixture.storage.sessions.get("monitor-session")?.revision);
      expect(tree.at(-1)?.id).toBe(prompt.id);
      await runEffect(fixture.worker.tick());
      expect(fixture.rows()).toHaveLength(1);
      expect(fixture.wakes).toEqual(["monitor-session"]);
    } finally {
      await fixture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }));

test("persistent polling takeover preserves dedupe and does not replay a restart gap", () =>
  Storage.withIsolation(async () => {
    const directory = mkdtempSync(join(tmpdir(), "watch-reopen-"));
    const database = join(directory, "ledger.db");
    const data = join(directory, "poll-result");
    writeFileSync(data, "");
    let fixture = alarmFixture(database);
    try {
      const first = fixture.next("stream");
      fixture.arm("stream", {
        command: `printf 'A\\n'; cat '${data}'; read value`,
        description: "idempotent poll",
        persistent: true,
      });
      await runEffect(fixture.worker.start());
      expect((await first).content).toBe("A");
      const fence = fixture.storage.alarms.get("stream")?.fence;
      await fixture.close();
      writeFileSync(data, "GAP\n");
      writeFileSync(data, "B\n");
      fixture = alarmFixture(database);
      const second = fixture.next("stream");
      await runEffect(fixture.worker.start());
      expect((await second).content).toBe("B");
      expect(fixture.rows().map((row) => row.content)).toEqual(["A", "B"]);
      expect(fixture.storage.alarms.get("stream")).toMatchObject({
        status: "armed",
        epoch: 1,
        notifications: 2,
      });
      expect(fixture.storage.alarms.get("stream")?.fence).toBeGreaterThan(fence ?? 0);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }));

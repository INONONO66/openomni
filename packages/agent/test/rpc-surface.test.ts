/**
 * #1253 — the four-entity-RPC surface replaces the nine old RPCs. Each
 * scenario below exercises one replaced path through `deliver`, `resolve` or
 * `alarm` against the REAL Session entity on a single-node cluster host, and
 * asserts exact chain states: appended row ids, typed rejection codes with
 * zero new facts, and stale alarm occurrences recorded as
 * `alarm{fired, outcome: stale}` facts that never wake the loop.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import { openCatalogStore } from "../src/core/store/catalog";
import { openSessionStore } from "../src/core/store/session-file";
import * as SessionHandleStore from "../src/core/store/fence";
import {
  clusterTempDir,
  readChain,
  runCluster,
  sendAlarm,
  sendDeliver,
  sendResolve,
  sessionFileFor,
} from "./helpers/cluster-runtime";
import { SessionNotFound } from "../src/core/store/errors";
import { seedSessionWithOpenRequest } from "./helpers/seed-request";
import { approvalAnswer } from "./helpers/request-fixtures";
import { runAgent } from "./helpers/executor";
import type { DeliverRefused } from "../src/core/messages";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-rpc-surface-");
const options = { sessionsDir, catalogFile };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Materialize + index one session; `prepare` runs under an adopted fence. */
async function seedSession(
  sessionId: string,
  prepare?: (input: {
    readonly kernel: SessionHandleStore.SessionKernel;
    readonly authority: { readonly owner: string; readonly fence: number };
  }) => Promise<void>,
): Promise<void> {
  const catalog = openCatalogStore(catalogFile, { now: () => 1 });
  const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
  const kernel = SessionHandleStore.createSessionKernel(store, catalog);
  try {
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
    catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
    if (prepare !== undefined) {
      const fence = catalog.rotateFence(sessionId);
      await runAgent(kernel.adoptFence({ sessionId, owner: "seeder", fence }));
      await prepare({ kernel, authority: { owner: "seeder", fence } });
    }
  } finally {
    store.close();
    catalog.close();
  }
}

test("a session absent from both planes refuses activation before any handler runs", () => {
  // Pins the invariant that lets the deliver handler read the session row
  // unguarded: activation reads the row first (fence rotation + adoption), and
  // BOTH planes throw SessionNotFound for an unknown session, so no handler
  // ever observes a missing row — the old in-handler `closed` fallback was
  // unreachable and is deleted.
  const sessionId = "surface-absent-session";
  const catalog = openCatalogStore(catalogFile, { now: () => 1 });
  const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
  try {
    expect(() => catalog.rotateFence(sessionId)).toThrow(SessionNotFound);
    const kernel = SessionHandleStore.createSessionKernel(store, catalog);
    expect(() => kernel.row(sessionId)).toThrow(SessionNotFound);
    expect(readChain(sessionFileFor(sessionsDir, sessionId), sessionId)).toEqual([]);
  } finally {
    store.close();
    catalog.close();
  }
});

test("deliver(prompt) replaces Prompt: the input row lands and a turn runs to seal", async () => {
  const sessionId = "surface-prompt";
  const receipt = await runCluster(
    options,
    sendDeliver(sessionId, { kind: "prompt", idempotencyKey: "p1", content: "hello" }),
  );
  expect(receipt.existed).toBe(false);
  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  expect(chain.find((row) => row.id === "p1")?.kind).toBe("prompt");
  expect(chain.find((row) => row.id === "p1")?.ordinal).toBe(receipt.seq);
  expect(chain.some((row) => row.id === "p1:delivery")).toBe(true);
  expect(chain.some((row) => row.id === "p1:turn:result")).toBe(true);
});

test("deliver(signal interrupt/resume) replaces Interrupt and Resume: idle control is consumed", async () => {
  const sessionId = "surface-signal";
  await runCluster(
    options,
    Effect.gen(function* () {
      const interrupt = yield* sendDeliver(sessionId, {
        kind: "signal",
        idempotencyKey: "i1",
        content: "interrupt it",
        control: "interrupt",
      });
      const resume = yield* sendDeliver(sessionId, {
        kind: "signal",
        idempotencyKey: "r1",
        content: "resume it",
        control: "resume",
      });
      expect(interrupt.existed).toBe(false);
      expect(resume.existed).toBe(false);
    }),
  );
  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  expect(chain.find((row) => row.id === "i1")?.kind).toBe("signal");
  expect(chain.some((row) => row.id === "i1:delivery")).toBe(true);
  expect(chain.some((row) => row.id === "r1:delivery")).toBe(true);
});

test("deliver with an unregistered kind is unknown_kind with zero new facts", async () => {
  const sessionId = "surface-unknown-kind";
  const before = await runCluster(
    options,
    Effect.gen(function* () {
      yield* sendDeliver(sessionId, { kind: "prompt", idempotencyKey: "seed", content: "seed" });
      return readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length;
    }),
  );
  const refusal = await runCluster(
    options,
    sendDeliver(sessionId, { kind: "action", idempotencyKey: "a1", content: "{}" }).pipe(
      Effect.flip,
    ),
  );
  expect((refusal as DeliverRefused).code).toBe("unknown_kind");
  expect(readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length).toBe(before);
});

test("resolve replaces RequestResolve/RequestCancel: answer resolves, cancel closes, both typed", async () => {
  const answered = "surface-resolve";
  const cancelled = "surface-cancel";
  const answerable = await seedSessionWithOpenRequest({
    sessionsDir,
    catalogFile,
    sessionId: answered,
    requestId: "req-answer",
  });
  await seedSessionWithOpenRequest({
    sessionsDir,
    catalogFile,
    sessionId: cancelled,
    requestId: "req-cancel",
  });
  await runCluster(
    options,
    Effect.gen(function* () {
      const answer = approvalAnswer(answerable, "answer-1", Date.now());
      const resolved = yield* sendResolve(answered, {
        requestId: "req-answer",
        outcome: "resolved",
        payload: JSON.stringify({ kind: "request.answer", answer }),
        inputId: "answer-1",
      });
      expect(resolved.resolution).toBe("resolved");
      const closed = yield* sendResolve(cancelled, {
        requestId: "req-cancel",
        outcome: "cancelled",
        payload: JSON.stringify({
          kind: "owner",
          principalId: "owner",
          evidenceId: "authenticated",
        }),
        inputId: "cancel-1",
      });
      expect(closed.resolution).toBe("cancelled");
    }),
  );
  const chain = readChain(sessionFileFor(sessionsDir, cancelled), cancelled);
  expect(chain.some((row) => row.id === "req-cancel:resolution")).toBe(true);
});

test("alarm(retry) replaces RetryScheduled: live attempt applies, unknown occurrence folds stale", async () => {
  const sessionId = "surface-retry";
  await seedSession(sessionId, async ({ kernel, authority }) => {
    const base = {
      sessionId,
      intent: { encodingVersion: 1 as const, value: { phase: "intent" } },
      effect: { encodingVersion: 1 as const, value: { phase: "pending" } },
      ts: 100,
      irreversible: true as const,
    };
    const row = kernel.row(sessionId);
    await runAgent(
      kernel.commit({
        sessionId,
        owner: authority.owner,
        fence: authority.fence,
        now: 100,
        expectedRevision: row.revision,
        actions: [
          { ...base, id: "op", parentId: null, kind: "llm" },
          { ...base, id: "op:attempt:1", parentId: "op", kind: "llm" },
        ],
        state: row.state,
      }),
    );
  });
  const live = await runCluster(
    options,
    sendAlarm(sessionId, {
      occurrenceId: "op:attempt:1:retry:1",
      purpose: "retry",
      alarmId: "op:attempt:1:retry:1",
      armSeq: 1,
      sourceKey: "retry",
      payload: JSON.stringify({ attempt: 1 }),
      fireAt: Date.now() - 1000,
    }),
  );
  expect(live.outcome).toBe("delivered");
  const stale = await runCluster(
    options,
    sendAlarm(sessionId, {
      occurrenceId: "missing:retry:1",
      purpose: "retry",
      alarmId: "missing:retry:1",
      armSeq: 1,
      sourceKey: "retry",
      payload: JSON.stringify({ attempt: 1 }),
      fireAt: Date.now() - 1000,
    }),
  );
  expect(stale.outcome).toBe("stale");
  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  const fact = chain.find((row) => row.id === "missing:retry:1:stale");
  expect(fact?.kind).toBe("alarm");
  // The loop was not woken: no turn envelope exists anywhere in the chain.
  expect(chain.some((row) => row.kind === "turn")).toBe(false);
});

test("alarm(deadline) replaces Deadline: open request applies, unknown request folds stale", async () => {
  const sessionId = "surface-deadline";
  await seedSessionWithOpenRequest({
    sessionsDir,
    catalogFile,
    sessionId,
    requestId: "req-deadline",
  });
  await runCluster(
    options,
    Effect.gen(function* () {
      const open = yield* sendAlarm(sessionId, {
        occurrenceId: "req-deadline:deadline",
        purpose: "deadline",
        alarmId: "req-deadline:deadline",
        armSeq: 1,
        sourceKey: "deadline",
        payload: JSON.stringify({ requestId: "req-deadline" }),
        fireAt: Date.now() - 1000,
      });
      expect(open.outcome).toBe("delivered");
      const unknown = yield* sendAlarm(sessionId, {
        occurrenceId: "missing:deadline",
        purpose: "deadline",
        alarmId: "missing:deadline",
        armSeq: 1,
        sourceKey: "deadline",
        payload: JSON.stringify({ requestId: "missing" }),
        fireAt: Date.now() - 1000,
      });
      expect(unknown.outcome).toBe("stale");
    }),
  );
  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  expect(chain.find((row) => row.id === "missing:deadline:stale")?.kind).toBe("alarm");
});

test("alarm(watch.fired/watch.timeout) replace WatchFired/WatchTimeout with chain-guarded folds", async () => {
  const sessionId = "surface-watch";
  await runCluster(
    options,
    Effect.gen(function* () {
      const fired = yield* sendAlarm(sessionId, {
        occurrenceId: "watch-occ-1",
        purpose: "watch.fired",
        alarmId: "w1",
        armSeq: 1,
        sourceKey: "watch-occ-1",
        payload: JSON.stringify({ watchId: "w1", epoch: 1, sourceKey: "watch-occ-1", batch: "[]" }),
        fireAt: Date.now() - 1000,
      });
      expect(fired.outcome).toBe("delivered");
      // A sourceKey already committed on the chain is a superseded occurrence.
      const supersededFired = yield* sendAlarm(sessionId, {
        occurrenceId: "watch-occ-2",
        purpose: "watch.fired",
        alarmId: "w1",
        armSeq: 1,
        sourceKey: `${sessionId}:materialize`,
        payload: JSON.stringify({
          watchId: "w1",
          epoch: 1,
          sourceKey: `${sessionId}:materialize`,
          batch: "[]",
        }),
        fireAt: Date.now() - 1000,
      });
      expect(supersededFired.outcome).toBe("stale");
      const timeout = yield* sendAlarm(sessionId, {
        occurrenceId: "w1:timeout:1",
        purpose: "watch.timeout",
        alarmId: "w1",
        armSeq: 1,
        sourceKey: "watch.timeout",
        payload: JSON.stringify({ watchId: "w1", epoch: 1 }),
        fireAt: Date.now() - 1000,
      });
      expect(timeout.outcome).toBe("delivered");
    }),
  );
  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  const fact = chain.find((row) => row.id === "watch-occ-2:stale");
  expect(fact?.kind).toBe("alarm");
  // Replay of the stale occurrence appends nothing: the fact id is idempotent.
  const before = chain.length;
  await runCluster(
    options,
    sendAlarm(sessionId, {
      occurrenceId: "watch-occ-2",
      purpose: "watch.fired",
      alarmId: "w1",
      armSeq: 1,
      sourceKey: `${sessionId}:materialize`,
      payload: JSON.stringify({
        watchId: "w1",
        epoch: 1,
        sourceKey: `${sessionId}:materialize`,
        batch: "[]",
      }),
      fireAt: Date.now() - 1000,
    }),
  );
  expect(readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length).toBe(before);
});

test("alarm with an unregistered purpose folds to a recorded stale fact, zero execution", async () => {
  const sessionId = "surface-unregistered-purpose";
  const receipt = await runCluster(
    options,
    sendAlarm(sessionId, {
      occurrenceId: "occ-unregistered-1",
      purpose: "cron.tick",
      alarmId: "cron-1",
      armSeq: 1,
      sourceKey: "cron",
      payload: JSON.stringify({ expr: "*/30 * * * *" }),
      fireAt: Date.now() - 1000,
    }),
  );
  expect(receipt.outcome).toBe("stale");
  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  const fact = chain.find((row) => row.id === "occ-unregistered-1:stale");
  expect(fact?.kind).toBe("alarm");
  // The loop was not woken: no turn envelope exists anywhere in the chain.
  expect(chain.some((row) => row.kind === "turn")).toBe(false);
});

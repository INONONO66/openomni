import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";
import { Core } from "@openomni/agent";
const SessionEntity = Core.SessionEntity;
type SessionEntityPorts = Core.SessionEntityPorts;
type SessionEntityTimerContext = Core.SessionEntityTimerContext;
type SessionEntityTurnInput = Core.SessionEntityTurnInput;
type ObservationPublishFailure = Core.ObservationPublishFailure;
const openCatalogStore = Core.openCatalogStore;
const openSessionStore = Core.openSessionStore;
import type { Inbox, ObservationSink } from "@openomni/protocol";
import { Effect } from "effect";
import { gatewayRuntime, runAppEffect } from "../src/gateway";
import {
  createAppLedger,
  createSessionEntityPortsSlot,
  sessionFilePath,
  sessionTimerPort,
} from "../src/composition/cluster-runtime";
import { runEffect } from "./helpers/effect";
import {
  requestFixture,
  requestStateAction,
} from "../../../packages/agent/test/store/helpers/request";
import { materializeSession } from "../../../packages/agent/test/store/helpers/session";
import { testClock } from "./helpers/test-entropy";
import { Bus } from "./helpers/bus";

/** A sink that refuses every post-commit publish. */
const REFUSING_SINK: ObservationSink = {
  publish() {
    throw new Error("sink failed");
  },
};

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "openomni-cluster-"));
  directories.push(directory);
  return directory;
}

/** Entity activations refuse unknown sessions: materialize + index first. */
async function provisionSession(
  catalogPath: string,
  sessionsDir: string,
  sessionId: string,
): Promise<void> {
  const now = testClock();
  const catalog = openCatalogStore(catalogPath, { now });
  const store = openSessionStore(sessionFilePath(sessionsDir, sessionId), { now });
  try {
    const kernel = Core.SessionHandleStore.createSessionKernel(store, catalog);
    await runEffect(
      kernel.materialize({
        actionId: `${sessionId}:materialize`,
        at: Date.now(),
        id: sessionId,
        parentId: null,
        policyGeneration: 1,
        role: "resident",
        system: { preset: "", blocks: [] },
        tools: [],
      }),
    );
    catalog.indexSession({
      id: sessionId,
      parentId: null,
      role: "resident",
      createdAt: Date.now(),
    });
  } finally {
    store.close();
    catalog.close();
  }
}

function origin(sessionId: string, messageId: string): string {
  const value: Inbox.MessageOrigin = {
    kind: "message",
    messageId,
    senderSessionId: sessionId,
    sourceActionId: messageId,
  };
  return JSON.stringify(value);
}

function readFence(catalogPath: string, sessionId: string): number | undefined {
  const db = new Database(catalogPath, { readonly: true });
  try {
    return db
      .query<{ fence: number }, [string]>("SELECT fence FROM session_index WHERE id = ?")
      .get(sessionId)?.fence;
  } finally {
    db.close();
  }
}

test("AppLive hosts the session entity: prompts append through the fenced kernel and dedupe on redelivery", async () => {
  const directory = tempDir();
  const catalogPath = join(directory, "catalog.sqlite");
  const sessionsDir = join(directory, "sessions");
  const sessionId = "cluster-app-session";
  const decisions: SessionEntityTurnInput["decision"]["kind"][] = [];
  const ports: SessionEntityPorts = {
    runTurn: (input) =>
      Effect.suspend(() => {
        decisions.push(input.decision.kind);
        // Detach a never-sealing body (W5.2 S4): the delivering RPC acks at
        // the durable boundary and later drains defer to the live turn.
        return input.detach(Effect.never);
      }),
    timers: sessionTimerPort(),
  };
  const runtime = gatewayRuntime({ observations: Bus,
    catalogPath,
    sessionsDir,
    entityIdleMs: 60_000,
    entity: { owner: "app-test-runner", ports },
  });
  try {
    await provisionSession(catalogPath, sessionsDir, sessionId);
    const message = {
      kind: "prompt",
      body: JSON.stringify({ content: "hello" }),
      source: origin(sessionId, "m-1"),
      idempotencyKey: "m-1",
    };
    const { first, replay, retry, deadline, fired, timeout } = await runAppEffect(
      runtime,
      Effect.scoped(
        Effect.gen(function* () {
          const makeClient = yield* SessionEntity.client;
          const entity = makeClient(sessionId);
          const first = yield* entity.Deliver(message);
          // Same idempotency key: the persisted envelope replays the recorded
          // receipt byte-identically; nothing runs twice.
          const replay = yield* entity.Deliver(message);
          // Chain-guarded alarm folds (F2/#1253): unknown alarm/request keys
          // and watch wakes without a composed watch plane (sessionTimerPort()
          // has no hooks here) fold to recorded stale facts — fail-closed.
          const retry = yield* entity.Alarm({
            occurrenceId: "missing-alarm:retry:1",
            purpose: "retry",
            alarmId: "missing-alarm:retry:1",
            armSeq: 1,
            sourceKey: "retry",
            payload: JSON.stringify({ attempt: 1 }),
            fireAt: Date.now(),
          });
          const deadline = yield* entity.Alarm({
            occurrenceId: "missing-request:deadline",
            purpose: "deadline",
            alarmId: "missing-request:deadline",
            armSeq: 1,
            sourceKey: "deadline",
            payload: JSON.stringify({ requestId: "missing-request" }),
            fireAt: Date.now(),
          });
          const fired = yield* entity.Alarm({
            occurrenceId: "missing-watch:1:missing-source",
            purpose: "watch.fired",
            alarmId: "missing-watch",
            armSeq: 1,
            sourceKey: "missing-watch:1:missing-source",
            payload: JSON.stringify({
              watchId: "missing-watch",
              epoch: 1,
              sourceKey: "missing-watch:1:missing-source",
              batch: "[]",
            }),
            fireAt: Date.now(),
          });
          const timeout = yield* entity.Alarm({
            occurrenceId: "missing-watch:timeout:1",
            purpose: "watch.timeout",
            alarmId: "missing-watch",
            armSeq: 1,
            sourceKey: "watch.timeout",
            payload: JSON.stringify({ watchId: "missing-watch", epoch: 1 }),
            fireAt: Date.now(),
          });
          return { first, replay, retry, deadline, fired, timeout };
        }),
      ),
    );
    expect(first).toEqual({ seq: 2, existed: false });
    expect(replay).toEqual(first);
    expect(retry).toEqual({ outcome: "stale" });
    expect(deadline).toEqual({ outcome: "stale" });
    expect(fired).toEqual({ outcome: "stale" });
    expect(timeout).toEqual({ outcome: "stale" });
    // The one admitted prompt started one (detached, never-sealing) turn;
    // the replay and the stale alarms never reach the turn port.
    expect(decisions).toEqual(["start"]);
    // One activation rotated the catalog fence exactly once (F5).
    expect(readFence(catalogPath, sessionId)).toBe(1);
  } finally {
    await runtime.dispose();
  }
}, 20_000);

test("a post-commit publish failure reaches the injected port and leaves the write result intact", () => {
  const failures: ObservationPublishFailure[] = [];
  const plane = createAppLedger({ now: testClock(),
    observationSink: REFUSING_SINK,
    onObservationFailure: (failure) => failures.push(failure),
  });
  try {
    const kernel = plane.openKernel("request-session");
    const fixture = requestFixture(kernel);
    fixture.commit([fixture.original]);
    expect(kernel.actionById("original")?.id).toBe("original");
    expect(failures.map((failure) => [failure.actionId, failure.cause.message])).toEqual([
      ["request-session:configure", "sink failed"],
      ["original", "sink failed"],
    ]);
  } finally {
    plane.close();
  }
});

test("without an injected port a publish failure on a file-mode handle is an incident log line", () => {
  const incident = spyOn(console, "error").mockImplementation((): void => undefined);
  const plane = createAppLedger({ now: testClock(),
    sessionsDir: join(tempDir(), "sessions"),
    observationSink: REFUSING_SINK,
  });
  const store = plane.handles.openSession("ported-session");
  try {
    materializeSession(Core.SessionHandleStore.createSessionKernel(store, plane.catalog), "ported-session");
    expect(store.sessions.get("ported-session")?.id).toBe("ported-session");
    expect(incident.mock.calls).toEqual([
      ["ledger observation publish failed: ported-session:configure", new Error("sink failed")],
    ]);
  } finally {
    incident.mockRestore();
    store.close();
    plane.close();
  }
});

test("deadline delivery expires an open request through the activation fence", async () => {
  const plane = createAppLedger({ now: testClock() });
  try {
    const kernel = plane.openKernel("request-session");
    const fixture = requestFixture(kernel);
    fixture.commit([fixture.original, requestStateAction(fixture.request)]);
    const outcome = await runEffect(
      sessionTimerPort().deadline(
        {
          authority: fixture.authority,
          kernel,
          now: fixture.request.deadline ?? 100,
        },
        {
          requestId: fixture.request.requestId,
          deadlineAt: fixture.request.deadline ?? 100,
        },
      ),
    );

    expect(outcome).toBe("applied");
    expect(kernel.requestById(fixture.request.requestId)?.state).toBe("expired");
  } finally {
    plane.close();
  }
});

test("late-bound entity ports refuse early use and forward after one binding", async () => {
  const plane = createAppLedger({ now: testClock() });
  try {
    const kernel = plane.openKernel("request-session");
    const fixture = requestFixture(kernel);
    fixture.commit([
      {
        id: "request-session:llm",
        parentId: "request-session:configure",
        sessionId: fixture.request.sessionId,
        kind: "llm",
        intent: { encodingVersion: 1, value: { phase: "intent" } },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
        ts: 100,
        irreversible: true,
      },
      {
        id: "request-session:llm:attempt:1",
        parentId: "request-session:llm",
        sessionId: fixture.request.sessionId,
        kind: "llm",
        intent: { encodingVersion: 1, value: { phase: "intent" } },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
        ts: 100,
        irreversible: true,
      },
    ]);
    const context: SessionEntityTimerContext = {
      authority: fixture.authority,
      kernel,
      now: 100,
    };
    expect(
      await runEffect(
        sessionTimerPort().retryScheduled(context, {
          alarmId: "request-session:llm:attempt:1:retry:1",
          attempt: 1,
          notBefore: 100,
        }),
      ),
    ).toBe("applied");
    const slot = createSessionEntityPortsSlot();
    await expect(
      runEffect(
        slot.ports.timers.retryScheduled(context, {
          alarmId: "retry",
          attempt: 1,
          notBefore: 100,
        }),
      ),
    ).rejects.toThrow("session entity ports are not bound yet");
    const forwarded: string[] = [];
    const ports: SessionEntityPorts = {
      runTurn: () => Effect.void,
      timers: {
        retryScheduled: () =>
          Effect.sync(() => {
            forwarded.push("retry");
            return "applied" as const;
          }),
        deadline: () => Effect.succeed("noop"),
        watchFired: () => Effect.succeed("noop"),
        watchTimeout: () =>
          Effect.sync(() => {
            forwarded.push("watch-timeout");
            return "applied" as const;
          }),
      },
      requestDomainRevisions: () => ({ person: 3 }),
    };
    slot.bind(ports);

    expect(
      await runEffect(
        slot.ports.timers.retryScheduled(context, {
          alarmId: "request-session:llm:attempt:1:retry:1",
          attempt: 1,
          notBefore: 100,
        }),
      ),
    ).toBe("applied");
    expect(
      await runEffect(
        slot.ports.timers.deadline(context, {
          requestId: "request",
          deadlineAt: 100,
        }),
      ),
    ).toBe("noop");
    expect(
      await runEffect(
        slot.ports.timers.watchFired(context, {
          watchId: "watch",
          epoch: 1,
          sourceKey: "watch:1:source",
          batch: "[]",
        }),
      ),
    ).toBe("noop");
    expect(
      await runEffect(
        slot.ports.timers.watchTimeout(context, {
          watchId: "watch",
          epoch: 1,
          fireAt: 100,
        }),
      ),
    ).toBe("applied");
    expect(slot.ports.requestDomainRevisions?.(fixture.request)).toEqual({ person: 3 });
    expect(forwarded).toEqual(["retry", "watch-timeout"]);
    expect(() => slot.bind(ports)).toThrow("session entity ports are already bound");
  } finally {
    plane.close();
  }
});

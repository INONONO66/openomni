import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import {
  SessionEntity,
  type SessionEntityPorts,
  type SessionEntityTimerContext,
  type SessionEntityTurnInput,
} from "@openomni/agent";
import { openCatalogStore, openSessionStore, SessionHandleStore } from "@openomni/ledger";
import type { Inbox } from "@openomni/protocol";
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
} from "../../../packages/ledger/test/helpers/request";

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
  const catalog = openCatalogStore(catalogPath);
  const store = openSessionStore(sessionFilePath(sessionsDir, sessionId));
  try {
    const kernel = SessionHandleStore.createSessionKernel(store, catalog);
    await runEffect(
      kernel.materialize({
        id: sessionId,
        parentId: null,
        role: "resident",
        tools: [],
        system: { preset: "", blocks: [] },
        policyGeneration: 1,
        actionId: `${sessionId}:materialize`,
        at: Date.now(),
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
      Effect.sync(() => {
        decisions.push(input.decision.kind);
      }),
    timers: sessionTimerPort(),
  };
  const runtime = gatewayRuntime({
    catalogPath,
    sessionsDir,
    entityIdleMs: 60_000,
    entity: { owner: "app-test-runner", ports },
  });
  try {
    await provisionSession(catalogPath, sessionsDir, sessionId);
    const message = { messageId: "m-1", content: "hello", origin: origin(sessionId, "m-1") };
    const { first, replay, timer, deadline, fired, timeout } = await runAppEffect(
      runtime,
      Effect.scoped(
        Effect.gen(function* () {
          const makeClient = yield* SessionEntity.client;
          const entity = makeClient(sessionId);
          const first = yield* entity.Prompt(message);
          const replay = yield* entity.Prompt(message);
          // Chain-guarded timer folds (F2): unknown alarm/request keys ack
          // durable no-ops; watch wakes without a composed watch plane
          // (sessionTimerPort() has no hooks here) ack no-ops — fail-closed.
          const timer = yield* entity.RetryScheduled({
            alarmId: "missing-alarm",
            attempt: 1,
            notBefore: Date.now(),
          });
          const deadline = yield* entity.Deadline({
            requestId: "missing-request",
            deadlineAt: Date.now(),
          });
          const fired = yield* entity.WatchFired({
            watchId: "missing-watch",
            epoch: 1,
            sourceKey: "missing-source",
            batch: "[]",
          });
          const timeout = yield* entity.WatchTimeout({
            watchId: "missing-watch",
            epoch: 1,
            fireAt: Date.now(),
          });
          return { first, replay, timer, deadline, fired, timeout };
        }),
      ),
    );
    expect(first).toEqual({ ordinal: 2, actionHash: first.actionHash, deduped: false });
    expect(replay).toEqual({ ordinal: 2, actionHash: first.actionHash, deduped: true });
    expect(timer).toEqual({ outcome: "noop" });
    expect(deadline).toEqual({ outcome: "noop" });
    expect(fired).toEqual({ outcome: "noop" });
    expect(timeout).toEqual({ outcome: "noop" });
    // The unconsumed prompt stays pending: both receives each drain into one
    // start decision; noop timer wakes never drain.
    expect(decisions).toEqual(["start", "start"]);
    // One activation rotated the catalog fence exactly once (F5).
    expect(readFence(catalogPath, sessionId)).toBe(1);
  } finally {
    await runtime.dispose();
  }
}, 20_000);

test("deadline delivery expires an open request through the activation fence", async () => {
  const plane = createAppLedger();
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
  const plane = createAppLedger();
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
        kind: "attempt",
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

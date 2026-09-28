import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import {
  SessionEntity,
  type SessionEntityPorts,
  type SessionEntityTurnInput,
} from "@openomni/agent";
import { openCatalogStore, openSessionStore, SessionHandleStore } from "@openomni/ledger";
import type { Inbox } from "@openomni/protocol";
import { Effect } from "effect";
import { gatewayRuntime, runAppEffect } from "../src/gateway";
import { sessionFilePath, sessionTimerPort } from "../src/composition/cluster-runtime";
import { runEffect } from "./helpers/effect";

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
          // durable no-ops; first-time watch deliveries are applied work.
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
    expect(fired).toEqual({ outcome: "applied" });
    expect(timeout).toEqual({ outcome: "applied" });
    // The unconsumed prompt stays pending: both receives and both applied
    // timer wakes each drain into one start decision.
    expect(decisions).toEqual(["start", "start", "start", "start"]);
    // One activation rotated the catalog fence exactly once (F5).
    expect(readFence(catalogPath, sessionId)).toBe(1);
  } finally {
    await runtime.dispose();
  }
}, 20_000);

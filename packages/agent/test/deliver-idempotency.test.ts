/**
 * #1253 — `deliver` idempotency: the required caller key is the durable row
 * id. A missing key is a typed `missing_key` rejection with zero new journal
 * facts; a replayed key returns the original seq as success
 * (`{seq, existed: true}`) with zero new facts and no duplicate-rejection
 * code anywhere on the path.
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect } from "effect";
import {
  clusterTempDir,
  readChain,
  runCluster,
  sendDeliver,
  sessionFileFor,
} from "./helpers/cluster-runtime";
import { openCatalogStore } from "../src/core/store/catalog";
import { openSessionStore } from "../src/core/store/session-file";
import * as SessionHandleStore from "../src/core/store/fence";
import { receivedMessageAction } from "../src/core/commit";
import { runAgent } from "./helpers/executor";
import type { DeliverRefused } from "../src/core/messages";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-deliver-idempotency-");
const options = { sessionsDir, catalogFile };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a blank idempotency key is missing_key and appends nothing", async () => {
  const sessionId = "idem-missing-key";
  const seeded = await runCluster(
    options,
    Effect.gen(function* () {
      yield* sendDeliver(sessionId, { kind: "prompt", idempotencyKey: "seed", content: "seed" });
      return readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length;
    }),
  );
  const refusal = await runCluster(
    options,
    sendDeliver(sessionId, { kind: "prompt", idempotencyKey: "  ", content: "keyless" }).pipe(
      Effect.flip,
    ),
  );
  expect((refusal as DeliverRefused).code).toBe("missing_key");
  expect(readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length).toBe(seeded);
});

test("a replayed key resolves to the original seq with zero new facts", async () => {
  const sessionId = "idem-replay";
  const { first, replay, divergent, between, after } = await runCluster(
    options,
    Effect.gen(function* () {
      const first = yield* sendDeliver(sessionId, {
        kind: "prompt",
        idempotencyKey: "p1",
        content: "original",
      });
      const between = readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length;
      // Same key, same envelope shape: the cluster replays the recorded
      // response — the receipt is byte-identical to the first and nothing runs.
      const replay = yield* sendDeliver(sessionId, {
        kind: "prompt",
        idempotencyKey: "p1",
        content: "original",
      });
      // Divergent content under the same key still resolves to the original row.
      const divergent = yield* sendDeliver(sessionId, {
        kind: "prompt",
        idempotencyKey: "p1",
        content: "something else entirely",
      });
      const after = readChain(sessionFileFor(sessionsDir, sessionId), sessionId).length;
      return { first, replay, divergent, between, after };
    }),
  );
  expect(first.existed).toBe(false);
  expect(replay).toEqual(first);
  expect(divergent).toEqual(first);
  expect(after).toBe(between);
});

test("a key already accepted on the journal returns {seq, existed: true} as success", async () => {
  const sessionId = "idem-journal-replay";
  // Seed the input row straight onto the chain: the handler-level dedup (not
  // the cluster envelope store) must resolve the replayed key.
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
    const fence = catalog.rotateFence(sessionId);
    await runAgent(kernel.adoptFence({ sessionId, owner: "seeder", fence }));
    const row = kernel.row(sessionId);
    await runAgent(
      kernel.commit({
        sessionId,
        owner: "seeder",
        fence,
        now: 2,
        expectedRevision: row.revision,
        actions: [
          receivedMessageAction({
            id: "seeded-key",
            sessionId,
            kind: "prompt",
            content: "seeded",
            origin: {
              encodingVersion: 1,
              value: {
                kind: "message",
                messageId: "seeded-key",
                senderSessionId: sessionId,
                sourceActionId: "seeded-key",
              },
            },
            parentActionId: null,
            at: 2,
          }),
        ],
        state: row.state,
      }),
    );
  } finally {
    store.close();
    catalog.close();
  }
  const seeded = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  const seq = seeded.find((chainRow) => chainRow.id === "seeded-key")?.ordinal;
  const receipt = await runCluster(
    options,
    sendDeliver(sessionId, { kind: "prompt", idempotencyKey: "seeded-key", content: "seeded" }),
  );
  expect(receipt).toEqual({ seq: seq as number, existed: true });
  // The activation drain runs the seeded prompt's turn; the replayed key
  // itself appends no new input row — exactly one "seeded-key" row exists.
  const chain = readChain(sessionFileFor(sessionsDir, sessionId), sessionId);
  expect(chain.filter((chainRow) => chainRow.id === "seeded-key")).toHaveLength(1);
  expect(
    chain.filter((chainRow) => chainRow.kind === "prompt" && !chainRow.id.endsWith(":delivery")),
  ).toHaveLength(1);
});

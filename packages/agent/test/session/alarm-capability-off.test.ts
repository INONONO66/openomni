/**
 * #1254 S4/S5 — capability-off conformance: with NO alarm capability composed,
 * the two loop-owned purposes still work end to end — a live `retry`
 * occurrence delivers (drain wake) and a live `deadline` occurrence expires
 * its open request — and the whole flow is deterministic: two independently
 * seeded worlds driven by the same injected clock produce BYTE-EQUAL journals
 * (every row id, ordinal, prev_hash and action_hash identical).
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { canonicalDigest, Alarm } from "@openomni/protocol";
import { Effect } from "effect";
import { armAction } from "../../src/core/alarm";
import { decideRequestTransition } from "../../src/core/request";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import * as SessionHandleStore from "../../src/core/store/fence";
import { openRequest } from "../helpers/open-request";
import {
  clusterTempDir,
  readChain,
  runCluster,
  sendAlarm,
  sessionFileFor,
  verifyChain,
  type ChainRow,
} from "../helpers/cluster-runtime";
import { runAgent } from "../helpers/executor";

const worlds = [clusterTempDir("w52-cap-off-a-"), clusterTempDir("w52-cap-off-b-")];

afterAll(() => {
  for (const world of worlds) rmSync(world.dir, { recursive: true, force: true });
});

const sessionId = "cap-off";
const requestId = "req-1";
// Already expired at the entity's injected now (5_000): the occurrence both
// delivers promptly (DeliverAt) and times the request out.
const SEED_DEADLINE = 2_000;
const ENTITY_NOW = 5_000;

/** Deterministic seed: materialize, retry arm, open request (deadline arm). */
function seedWorld(world: (typeof worlds)[number]): Effect.Effect<void> {
  return Effect.gen(function* () {
    const catalog = openCatalogStore(world.catalogFile, { now: () => 1 });
    const store = openSessionStore(sessionFileFor(world.sessionsDir, sessionId), { now: () => 1 });
    const kernel = SessionHandleStore.createSessionKernel(store, catalog);
    yield* kernel.materialize({
      id: sessionId,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 1,
      actionId: `${sessionId}:materialize`,
      at: 1,
    });
    catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
    const fence = catalog.rotateFence(sessionId);
    yield* kernel.adoptFence({ sessionId, owner: "seeder", fence });
    const commit = (actions: Parameters<typeof kernel.commit>[0]["actions"]) => {
      const row = kernel.row(sessionId);
      return kernel.commit({
        sessionId,
        owner: "seeder",
        fence,
        now: 100,
        expectedRevision: row.revision,
        actions,
        state: row.state,
      });
    };
    const parsedInput = {};
    // The retried operation and its armed retry chain.
    const base = {
      sessionId,
      ts: 100,
      irreversible: true as const,
    };
    const retryArm = armAction({
      parentId: "op:attempt:1",
      sessionId,
      purpose: "retry",
      at: 100,
      supersedes: null,
      alarmId: "op:attempt:1:retry",
      sourceKey: "retry",
      payload: { attempt: 1, reason: "transient_error" },
      armSeq: 1,
      ts: 100,
    });
    yield* commit([
      {
        ...base,
        id: "op",
        parentId: `${sessionId}:materialize`,
        kind: "llm",
        intent: { encodingVersion: 1, value: { phase: "intent" } },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
      },
      {
        ...base,
        id: "op:attempt:1",
        parentId: "op",
        kind: "llm",
        intent: { encodingVersion: 1, value: { phase: "intent" } },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
      },
      retryArm.action,
      {
        ...base,
        id: requestId,
        parentId: `${sessionId}:materialize`,
        kind: "tool",
        intent: {
          encodingVersion: 1,
          value: {
            phase: "intent",
            op: "write",
            value: parsedInput,
            effectHash: canonicalDigest({ category: "mutation" }),
          },
        },
        effect: { encodingVersion: 1, value: { phase: "pending" } },
      },
    ]);
    const row = kernel.row(sessionId);
    const request = openRequest({
      requestId,
      sessionId,
      turnId: null,
      callId: `${requestId}:call`,
      parsedInput,
      generation: row.policyGeneration,
      toolsGeneration: row.toolsGeneration,
      systemHash: row.systemHash,
      deadline: SEED_DEADLINE,
      createdAt: 1_000,
    });
    const decision = decideRequestTransition(
      {
        version: 1,
        sessionId,
        inputId: `${requestId}:open-input`,
        at: 1_000,
        expectedRevision: row.revision,
        authority: { owner: "seeder", fence },
        payload: { kind: "request.open", request },
      },
      { row, requests: [], invocation: kernel.actionById(requestId) },
    );
    if (decision.resolution !== "opened") throw new Error(`seed refused: ${decision.resolution}`);
    yield* commit([...decision.actions]);
    store.close();
    catalog.close();
  }).pipe(Effect.orDie);
}

/** Drive one world: retry fires, then the deadline expires the open request. */
function driveWorld(world: (typeof worlds)[number]): Promise<ChainRow[]> {
  return runCluster(
    { sessionsDir: world.sessionsDir, catalogFile: world.catalogFile, clock: () => ENTITY_NOW },
    Effect.gen(function* () {
      const retry = yield* sendAlarm(sessionId, {
        occurrenceId: Alarm.occurrenceId(sessionId, "op:attempt:1:retry", 1, "retry"),
        purpose: "retry",
        alarmId: "op:attempt:1:retry",
        armSeq: 1,
        sourceKey: "retry",
        payload: JSON.stringify({ attempt: 1, reason: "transient_error" }),
        fireAt: 100,
      });
      expect(retry.outcome).toBe("delivered");
      const deadline = yield* sendAlarm(sessionId, {
        occurrenceId: Alarm.occurrenceId(sessionId, `${requestId}:deadline`, 1, "deadline"),
        purpose: "deadline",
        alarmId: `${requestId}:deadline`,
        armSeq: 1,
        sourceKey: "deadline",
        payload: JSON.stringify({ requestId }),
        // The occurrence id is the cluster dedupe key: this send attaches to
        // the activation-resent envelope (same identity, DeliverAt 2_000).
        fireAt: SEED_DEADLINE,
      });
      expect(deadline.outcome).toBe("delivered");
      return readChain(sessionFileFor(world.sessionsDir, sessionId), sessionId);
    }),
  );
}

test("retry + deadline fire with no capability composed; two worlds yield byte-equal journals", async () => {
  for (const world of worlds) await runAgent(seedWorld(world));
  const [chainA, chainB] = [await driveWorld(worlds[0] as (typeof worlds)[number]), await driveWorld(worlds[1] as (typeof worlds)[number])];

  // The loop-owned purposes ran without any capability: retry delivered and
  // the deadline timed the request out (terminal + chain retire + fired fact).
  const ids = chainA.map((row) => row.id);
  expect(ids).toContain(`${Alarm.occurrenceId(sessionId, "op:attempt:1:retry", 1, "retry")}:delivered`);
  expect(ids).toContain(`${requestId}:resolution`);
  expect(ids).toContain(`${requestId}:deadline:arm:2`);
  expect(ids).toContain(`${Alarm.occurrenceId(sessionId, `${requestId}:deadline`, 1, "deadline")}:delivered`);

  // Determinism: every row (id, kind, ordinal, prev_hash, action_hash) is
  // identical across the two worlds — action_hash covers the full row bytes.
  expect(chainA).toEqual(chainB);
  for (const world of worlds) {
    expect(verifyChain(sessionFileFor(world.sessionsDir, sessionId), sessionId)).toBe(chainA.length);
  }
});

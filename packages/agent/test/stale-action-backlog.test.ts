import { beforeEach, expect, test } from "bun:test";
import { Inbox, type LedgerAction, type PlainValue, SessionGeneration } from "@openomni/protocol";
import { staleActionBacklog, turnIntentAction } from "../src/core/commit";
import type * as SessionHandleStore from "../src/core/store/fence";
import { materializeSession } from "./store/helpers/session";
import { useMemoryStores } from "./store/helpers/storage";

/**
 * #1256 H-3: a deferred `action` input carries the journal ordinal (`after`)
 * its payload was computed against. One pointing BEFORE the latest executed
 * compaction reasons about a context that no longer exists: it is never
 * consumed — the next turn closes it durably via `turn.consumed.stale` — and
 * the pending fold drops it from every later backlog.
 */

function row(id: string, kind: Inbox.Kind, after?: number): Inbox.Row {
  return Inbox.Row.parse({
    id,
    sessionId: "s",
    kind,
    content: "{}",
    origin: { encodingVersion: 1, value: { kind: "hook.late" } },
    ...(after === undefined ? {} : { after }),
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt: 1,
    ordinal: 1,
  });
}

test("staleActionBacklog: only action inputs with after < compaction head fold stale", () => {
  const prompt = row("p1", "prompt");
  const oldAction = row("a1", "action", 3);
  const boundaryAction = row("a2", "action", 5);
  const freshAction = row("a3", "action", 9);
  const cursorless = row("a4", "action");
  const { live, stale } = staleActionBacklog(
    [prompt, oldAction, boundaryAction, freshAction, cursorless],
    5,
  );
  expect(stale.map((item) => item.id)).toEqual(["a1"]);
  expect(live.map((item) => item.id)).toEqual(["p1", "a2", "a3", "a4"]);
  // No compaction yet (head 0): nothing is stale.
  expect(staleActionBacklog([oldAction], 0).stale).toEqual([]);
});

test("turnIntentAction journals consumedStale on the turn intent; an empty list stays absent", () => {
  const generation = SessionGeneration.Snapshot.parse({
    generation: 1,
    revertTo: 0,
    tools: [],
    toolsHash: "t",
    systemPreset: "",
    systemBlocks: [],
    systemValue: "",
    systemHash: "s",
    policyGeneration: 1,
  });
  const base = {
    id: "turn-1",
    parentId: null,
    sessionId: "s",
    resultId: "r1",
    inboxIds: ["p1"],
    generation,
    resumeCount: 0,
    boundaryActionId: null,
    at: 1,
  };
  const closed = turnIntentAction({ ...base, consumedStale: ["a1", "a2"] });
  expect((closed.intent.value as { consumedStale?: string[] }).consumedStale).toEqual(["a1", "a2"]);
  const clean = turnIntentAction({ ...base, consumedStale: [] });
  expect("consumedStale" in (clean.intent.value as object)).toBe(false);
});

const stores = useMemoryStores();
let kernel: SessionHandleStore.SessionKernel;
beforeEach(() => {
  kernel = stores.kernel;
  materializeSession(kernel, "stale");
});

function append(id: string, kind: LedgerAction.Kind, intent: PlainValue, effect: PlainValue) {
  const receipt = stores.session.actions.append(
    {
      id,
      kind,
      intent: { encodingVersion: 1, value: intent },
      effect: { encodingVersion: 1, value: effect },
      sessionId: "stale",
      parentId: null,
      irreversible: true,
      ts: 2,
    },
    kernel.row("stale").revision,
  );
  if (receipt === undefined) throw new Error(`append refused: ${id}`);
  return receipt.action;
}

test("the chain fold: after rides the pending row, compactionHead is the executed compaction, turn.consumedStale closes", () => {
  append("p1", "prompt", { kind: "message" }, { inboxKind: "prompt", content: "hi" });
  append("a1", "action", { kind: "hook.late", after: 1 }, { inboxKind: "action", content: "{}" });
  // No executed compaction yet: head is 0, nothing can be stale.
  expect(kernel.compactionHead("stale")).toBe(0);
  const compaction = append(
    "c1",
    "compaction",
    { reason: "threshold" },
    { phase: "result", terminal: "executed", result: { projection: [] } },
  );
  expect(kernel.compactionHead("stale")).toBe(compaction.ordinal);
  append(
    "a2",
    "action",
    { kind: "hook.late", after: compaction.ordinal },
    { inboxKind: "action", content: "{}" },
  );

  const pending = kernel.pendingMessages("stale");
  expect(pending.map((item) => [item.id, item.after ?? null])).toEqual([
    ["p1", null],
    ["a1", 1],
    ["a2", compaction.ordinal],
  ]);
  const { live, stale } = staleActionBacklog(pending, kernel.compactionHead("stale"));
  expect(stale.map((item) => item.id)).toEqual(["a1"]);
  expect(live.map((item) => item.id)).toEqual(["p1", "a2"]);

  // The turn closes the stale input via its intent's consumedStale list: the
  // pending fold (SQL projection) never surfaces it again.
  append(
    "t1",
    "turn",
    { phase: "intent", inboxIds: [], consumedStale: ["a1"] },
    { phase: "pending" },
  );
  expect(kernel.pendingMessages("stale").map((item) => item.id)).toEqual(["p1", "a2"]);
});

// ---------------------------------------------------------------------------
// #1256 H-1 (r3): a LIVE boundary (after_tools, mid-turn) closes a stale
// action instead of delivering it — the split runs inside the one
// boundary-consumption function, not only at turn start.
// ---------------------------------------------------------------------------

import { Deferred, Effect, Fiber } from "effect";
import { boundaryConsumption, DEFAULT_CONSUMPTION } from "../src/core/commit";
import type { SessionRunner } from "../src/core/run";
import { session } from "../src/testing/registry";
import { isolated, isolatedLedger } from "./helpers/isolated";
import { commitReceivedMessage } from "./helpers/ingress";
import { seedPolicy } from "./helpers/seed-policy";
import { sessionTree } from "./helpers/session-tree";
import {
  allowConfigure,
  isolatedRuntime,
  withSessionServices,
  type SessionFixture,
} from "./helpers/session-services";

test("boundaryConsumption applies the stale split at every boundary", () => {
  const staleSteer = { ...row("a1", "action", 3), delivery: "steer" as const };
  const liveSteer = { ...row("a2", "action", 9), delivery: "steer" as const };
  const out = boundaryConsumption([staleSteer, liveSteer], "after_tools", DEFAULT_CONSUMPTION, 5);
  expect(out.consumed.map((item) => item.id)).toEqual(["a2"]);
  expect(out.stale.map((item) => item.id)).toEqual(["a1"]);
});

function fixture(): SessionFixture {
  let sequence = 0;
  return {
    authorizeConfigure: allowConfigure,
    observations: { publish: () => undefined, subscribe: () => () => undefined },
    clock: () => 30,
    entropy: () => `sb-${++sequence}`,
    processId: "sb",
    ...isolatedRuntime(),
  };
}

const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout("2 seconds"));

test("a stale action delivered DURING a turn closes via turn.consumed.stale at the live boundary; zero delivery", () =>
  isolated(
    Effect.gen(function* () {
      seedPolicy();
      const runtime = fixture();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const drained: string[][] = [];
      const declare = (runner: SessionRunner) =>
        withSessionServices(session({ id: "S", role: "resident", runner }, runtime), runtime);
      const handle = yield* declare((input) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          const batch = yield* input.boundary("after_tools");
          drained.push(batch.messages.map((message) => message.text));
          return { kind: "result", text: "done" };
        }),
      );
      const kernel = isolatedLedger().kernel;
      // An EXECUTED compaction before the turn: the head every later cursor
      // is measured against.
      const current = kernel.row("S");
      const writer =
        current.fenceOwner === null
          ? kernel
              .adoptFence({ sessionId: "S", owner: "compactor", fence: current.fence + 1 })
              .pipe(Effect.map((adopted) => ({ owner: "compactor", fence: adopted.fence })))
          : Effect.succeed({ owner: current.fenceOwner, fence: current.fence });
      yield* writer.pipe(
        Effect.flatMap(({ owner, fence }) =>
          kernel.commit({
            sessionId: "S",
            owner,
            fence,
            now: 29,
            expectedRevision: current.revision,
            actions: [
              {
                id: "compaction-1",
                parentId: kernel.latestAction("S")?.id ?? null,
                sessionId: "S",
                kind: "compaction",
                intent: { encodingVersion: 1, value: { reason: "threshold" } },
                effect: {
                  encodingVersion: 1,
                  value: { phase: "result", terminal: "executed", result: { projection: [] } },
                },
                irreversible: true,
                ts: 29,
              },
            ],
            state: current.state,
          }),
        ),
      );
      expect(kernel.compactionHead("S")).toBeGreaterThan(1);
      const running = yield* Effect.forkScoped(handle.prompt("start"));
      yield* bounded(Deferred.await(entered));
      // Mid-turn, a late hook result arrives through the deliver door as a
      // steer action whose after cursor points BEFORE the compaction head.
      yield* commitReceivedMessage(kernel, {
        id: "stale-action",
        sessionId: "S",
        kind: "action",
        content: "{}",
        origin: { encodingVersion: 1, value: { kind: "hook.late", after: 1 } },
        createdAt: 31,
        parentActionId: kernel.latestAction("S")?.id ?? null,
        delivery: "steer",
      });
      yield* Deferred.succeed(release, undefined);
      yield* bounded(Fiber.join(running));
      // The live after_tools boundary did NOT deliver the stale action...
      expect(drained[0]).toEqual([]);
      const actions = sessionTree(kernel, "S");
      const deliveries = actions.filter(
        (action) =>
          (action.intent.value as { inboxId?: string } | null)?.inboxId === "stale-action",
      );
      expect(deliveries).toEqual([]);
      // ...it closed it durably via the checkpoint's turn.consumed.stale...
      const checkpoints = actions.filter(
        (action) =>
          action.kind === "turn" &&
          (action.intent.value as { phase?: string }).phase === "checkpoint",
      );
      expect(
        checkpoints.map(
          (action) => (action.intent.value as { consumedStale?: string[] }).consumedStale,
        ),
      ).toContainEqual(["stale-action"]);
      // ...and the pending fold never surfaces it again.
      expect(kernel.pendingMessages("S").map((item) => item.id)).toEqual([]);
    }),
  ));

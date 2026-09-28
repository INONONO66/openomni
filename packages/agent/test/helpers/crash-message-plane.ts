import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs";
import { Clock, Effect } from "effect";
import { TestClock } from "effect/testing";
import type { LedgerError } from "@openomni/ledger";
import { Inbox, LedgerAction, SessionTransition } from "@openomni/protocol";
import { z } from "zod";
import { sessionTree } from "./session-tree";
import type { SessionKernel } from "../../src/cluster/kernel-registry";
import { watchFiredDelivery, type TimerChainReads } from "../../src/cluster/timers";
import { CommitFailed } from "../../src/errors";
import { receivedMessageAction, receivedMessages } from "../../src/session-record";
import { closeSessions, session } from "../../src/session-handle";
import { isolated, isolatedLedger } from "./isolated";
import { openCrashStores } from "./crash-stores";
import { awaitCrashStart, holdCrashBarrier } from "./crash-channel";
import { receiveOutbound } from "./effect-g2";
import { seedPolicy } from "./seed-policy";
import { reactivateSession } from "./wake-session";
import { allowConfigure, isolatedRuntime, type SessionFixture, withSessionServices } from "./session-services";

export const messagePlanePoint = z.enum([
  "delivery_ack_committed_before_owner_cleanup",
  "platform_send_committed_before_local_ack_reconciled_sent",
  "platform_attempt_marker_before_send_reconciled_not_sent",
  "platform_send_ambiguous_without_reconciliation",
  "outbound_flood_deadline_before_timer_rearm",
  "watch_fired_committed_before_entity_wake",
]);
export const messagePlaneProof = z.object({
  before: z.array(LedgerAction.Node), after: z.array(LedgerAction.Node), repeated: z.array(LedgerAction.Node),
  outboundBefore: z.array(SessionTransition.Outbound), outboundAfter: z.array(SessionTransition.Outbound),
  inboxBefore: z.array(Inbox.Row), inboxAfter: z.array(Inbox.Row),
  dispatches: z.number(), sourceRuns: z.number(), destinationRuns: z.number(),
  externalBefore: z.array(z.string()), externalAfter: z.array(z.string()),
  watch: z.object({ occurrenceId: z.string(), redelivery: z.string(), fired: z.number() }).nullable(),
}).strict();
const sessionId = "crash-session";
const watchId = "doorbell";
const occurrenceId = `${watchId}:fired:1`;

function timerReads(kernel: SessionKernel): TimerChainReads {
  return {
    actionById: kernel.actionById,
    requestById: kernel.requestById,
    resultFor: (id: string) => kernel.resultFor(sessionId, id),
    operationChildrenPage: (id: string, cursor?: number) =>
      kernel.operationChildrenPage(sessionId, id, cursor),
  };
}

/**
 * A WatchFired delivery on the entity plane (W5.2 F2): the chain-guard admits
 * the first occurrence, then one fenced batch commits the occurrence action
 * and the pending wake prompt together. The cut lands before any wake.
 */
function watchCut() {
  return Effect.gen(function* () {
    yield* TestClock.setTime(100);
    const now = yield* Clock.currentTimeMillis;
    const kernel = isolatedLedger().kernel;
    let hibernated = 0;
    const runtime: SessionFixture = {
      ...isolatedRuntime(),
      authorizeConfigure: allowConfigure, observations: { publish: () => undefined }, clock: () => now,
      onHibernate: () => Effect.sync(() => { hibernated += 1; }),
    };
    const handle = yield* withSessionServices(session({
      id: sessionId, role: "resident", runner: () => Effect.succeed({ kind: "result", text: "idle" }),
    }, runtime), runtime);
    yield* handle.prompt("initialize");
    if (hibernated !== 1) throw new Error("session did not hibernate before the watch fired");
    if (watchFiredDelivery(timerReads(kernel), occurrenceId).op !== "run")
      throw new Error("fresh occurrence must be admitted");
    const row = kernel.row(sessionId);
    if (row.leaseOwner === null) throw new Error("hibernated session lost its pinned writer");
    yield* kernel.commit({
      sessionId, owner: row.leaseOwner, fence: row.leaseFence, now,
      expectedRevision: row.revision, state: row.state,
      actions: [
        {
          id: occurrenceId, sessionId, parentId: null, kind: "alarm.fired",
          intent: { encodingVersion: 1, value: { watchId, epoch: 1, sourceKey: `timer:${now}`, batch: "b1" } },
          effect: { encodingVersion: 1, value: { phase: "fired", terminal: true } },
          ts: now, irreversible: true,
        },
        receivedMessageAction({
          id: `${occurrenceId}:prompt`, sessionId, kind: "prompt", content: "watch prompt",
          origin: { encodingVersion: 1, value: { watchId } }, parentActionId: occurrenceId, at: now,
        }),
      ],
    }).pipe(Effect.mapError((error: LedgerError) => new CommitFailed({ error })));
    const after = kernel.row(sessionId);
    return holdCrashBarrier(JSON.stringify({
      crashPoint: "watch_fired_committed_before_entity_wake", bodies: [],
      lease: { owner: after.leaseOwner, fence: after.leaseFence }, openTurns: [],
    }));
  });
}

function platformEntries(dbPath: string): string[] {
  const path = `${dbPath}.platform`;
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

function recover(point: z.infer<typeof messagePlanePoint>, dbPath: string) {
  return Effect.gen(function* () {
    yield* TestClock.setTime(200_000);
    const now = yield* Clock.currentTimeMillis;
    const kernel = isolatedLedger().kernel;
    const before = sessionTree(kernel, sessionId);
    const outboundBefore = kernel.outboundRows(sessionId);
    const watch = point === "watch_fired_committed_before_entity_wake";
    const inboxBefore = receivedMessages(kernel, watch ? sessionId : "parent").rows;
    const externalBefore = platformEntries(dbPath);
    let dispatches = 0;
    let sourceRuns = 0;
    let destinationRuns = 0;
    const runtime: SessionFixture = {
      ...isolatedRuntime(),
      authorizeConfigure: allowConfigure, observations: { publish: () => undefined }, clock: () => now,
      dispatchOutbound: ({ message }) => Effect.gen(function* () {
        dispatches += 1;
        if (point === "platform_send_committed_before_local_ack_reconciled_sent" || point === "platform_send_ambiguous_without_reconciliation")
          appendFileSync(`${dbPath}.platform`, `${message.messageId}\n`);
        return (yield* receiveOutbound(message, now)).receipt;
      }),
    };
    const runner = () => Effect.sync(() => {
      sourceRuns += 1;
      return { kind: "result" as const, text: "rehydrated" };
    });
    const receiver = () => Effect.sync(() => {
      destinationRuns += 1;
      return { kind: "result" as const, text: "received" };
    });
    // Zero re-fire: the committed occurrence makes every redelivery a chain-guarded no-op.
    const redelivery = watchFiredDelivery(timerReads(kernel), occurrenceId);
    if (watch && JSON.stringify(watchFiredDelivery(timerReads(kernel), occurrenceId)) !== JSON.stringify(redelivery))
      throw new Error("watch redelivery must stay a stable no-op");
    yield* withSessionServices(reactivateSession(sessionId, runner, runtime), runtime);
    if (!watch) yield* withSessionServices(reactivateSession("parent", receiver, runtime), runtime);
    const after = sessionTree(kernel, sessionId);
    yield* withSessionServices(reactivateSession(sessionId, runner, runtime), runtime);
    if (!watch) yield* withSessionServices(reactivateSession("parent", receiver, runtime), runtime);
    const proof = messagePlaneProof.parse({
      before, after, repeated: sessionTree(kernel, sessionId), outboundBefore,
      outboundAfter: kernel.outboundRows(sessionId), inboxBefore,
      inboxAfter: receivedMessages(kernel, watch ? sessionId : "parent").rows,
      dispatches, sourceRuns, destinationRuns, externalBefore, externalAfter: platformEntries(dbPath),
      watch: watch
        ? {
            occurrenceId,
            redelivery: redelivery.op === "skip" ? redelivery.reason : redelivery.op,
            fired: sessionTree(kernel, sessionId).filter((action) => action.kind === "alarm.fired").length,
          }
        : null,
    });
    yield* closeSessions(runtime);
    return proof;
  });
}

if (import.meta.main) {
  const [stage, point, dbPath] = z.tuple([z.enum(["crash", "recover"]), messagePlanePoint, z.string().min(1)]).parse(process.argv.slice(2));
  awaitCrashStart();
  const proof = await isolated(Effect.gen(function* () {
    if (stage === "crash") {
      seedPolicy();
      return yield* watchCut();
    }
    return yield* recover(point, dbPath);
  }).pipe(Effect.provide(TestClock.layer())), () => openCrashStores(dbPath));
  writeSync(1, `${JSON.stringify(proof)}\n`);
}

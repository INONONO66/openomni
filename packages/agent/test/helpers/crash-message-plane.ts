import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs";
import { Clock, Effect, TestClock, TestContext } from "effect";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { Alarm, Inbox, LedgerAction, SessionTransition } from "@openomni/protocol";
import { z } from "zod";
import { sessionTree } from "../../../ledger/test/helpers/session-tree";
import { closeSessions, session, wakeSession } from "../../src/session-handle";
import { isolated } from "./isolated";
import { awaitCrashStart, holdCrashBarrier } from "./crash-channel";
import { receiveOutbound } from "./effect-g2";
import { seedPolicy } from "./seed-policy";
import { allowConfigure, type SessionFixture, withSessionServices } from "./session-services";

export const messagePlanePoint = z.enum([
  "delivery_ack_committed_before_owner_cleanup",
  "platform_send_committed_before_local_ack_reconciled_sent",
  "platform_attempt_marker_before_send_reconciled_not_sent",
  "platform_send_ambiguous_without_reconciliation",
  "outbound_flood_deadline_before_timer_rearm",
  "alarm_fire_committed_before_hibernated_doorbell",
]);
export const messagePlaneProof = z.object({
  before: z.array(LedgerAction.Node), after: z.array(LedgerAction.Node), repeated: z.array(LedgerAction.Node),
  outboundBefore: z.array(SessionTransition.Outbound), outboundAfter: z.array(SessionTransition.Outbound),
  inboxBefore: z.array(Inbox.Row), inboxAfter: z.array(Inbox.Row),
  dispatches: z.number(), sourceRuns: z.number(), destinationRuns: z.number(),
  externalBefore: z.array(z.string()), externalAfter: z.array(z.string()),
  alarm: Alarm.Row.nullable(), leaseReleased: z.boolean(),
}).strict();
const sessionId = "crash-session";
const alarmId = "doorbell";

function alarmCut() {
  return Effect.gen(function* () {
    yield* TestClock.setTime(100);
    const now = yield* Clock.currentTimeMillis;
    let hibernated = 0;
    const runtime: SessionFixture = {
      authorizeConfigure: allowConfigure, observations: { publish: () => undefined }, clock: () => now,
      onHibernate: () => Effect.sync(() => { hibernated += 1; }),
    };
    const handle = yield* withSessionServices(session({
      id: sessionId, role: "resident", runner: () => Effect.succeed({ kind: "result", text: "idle" }),
    }, runtime), runtime);
    yield* handle.prompt("initialize");
    if (hibernated !== 1) throw new Error("session did not hibernate before alarm");
    const alarms = Storage.get().alarms;
    if (alarms === undefined) throw new Error("alarm adapter missing");
    yield* alarms.arm({ id: alarmId, sessionId, kind: "at", fireAt: now });
    const owned = yield* alarms.acquire(alarmId, 0);
    yield* alarms.fire({
      id: alarmId, epoch: owned.epoch, fence: owned.fence, sourceKey: `timer:${now}`,
      at: now, content: "alarm prompt", terminal: true,
    });
    const row = SessionHandleStore.row(sessionId);
    return holdCrashBarrier(JSON.stringify({
      crashPoint: "alarm_fire_committed_before_hibernated_doorbell", bodies: [],
      lease: { owner: row.leaseOwner, fence: row.leaseFence, expiresAt: row.leaseExpiresAt }, openTurns: [],
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
    const before = sessionTree(sessionId);
    const outboundBefore = SessionHandleStore.outboundRows(sessionId);
    const alarm = point === "alarm_fire_committed_before_hibernated_doorbell";
    const inboxBefore = SessionHandleStore.inboxRows(alarm ? sessionId : "parent");
    const externalBefore = platformEntries(dbPath);
    let dispatches = 0;
    let sourceRuns = 0;
    let destinationRuns = 0;
    const runtime: SessionFixture = {
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
    yield* withSessionServices(wakeSession(sessionId, runner, runtime), runtime);
    if (!alarm) yield* withSessionServices(wakeSession("parent", receiver, runtime), runtime);
    // C3's idle source does not own cleanup. Reclaim the expired lease explicitly.
    const row = SessionHandleStore.row(sessionId);
    if (row.leaseOwner !== null) {
      const lease = yield* SessionHandleStore.acquireLease({
        sessionId, owner: "cleanup", expectedFence: row.leaseFence, now, expiresAt: now + 30_000,
      });
      yield* SessionHandleStore.commit({
        sessionId, owner: "cleanup", fence: lease.fence, now, expectedRevision: row.revision,
        actions: [], consumeInboxIds: [], state: row.state, releaseLease: true,
      });
    }
    const after = sessionTree(sessionId);
    yield* withSessionServices(wakeSession(sessionId, runner, runtime), runtime);
    if (!alarm) yield* withSessionServices(wakeSession("parent", receiver, runtime), runtime);
    const proof = messagePlaneProof.parse({
      before, after, repeated: sessionTree(sessionId), outboundBefore,
      outboundAfter: SessionHandleStore.outboundRows(sessionId), inboxBefore,
      inboxAfter: SessionHandleStore.inboxRows(alarm ? sessionId : "parent"),
      dispatches, sourceRuns, destinationRuns, externalBefore, externalAfter: platformEntries(dbPath),
      alarm: Storage.get().alarms?.get(alarmId) ?? null,
      leaseReleased: SessionHandleStore.row(sessionId).leaseOwner === null,
    });
    yield* closeSessions(runtime);
    return proof;
  });
}

if (import.meta.main) {
  const [stage, point, dbPath] = z.tuple([z.enum(["crash", "recover"]), messagePlanePoint, z.string().min(1)]).parse(process.argv.slice(2));
  awaitCrashStart();
  const proof = await isolated(Effect.gen(function* () {
    Storage.reset(); Storage.initialize({ dbPath });
    seedPolicy();
    if (stage === "crash") return yield* alarmCut();
    return yield* recover(point, dbPath);
  }).pipe(Effect.provide(TestContext.TestContext)));
  writeSync(1, `${JSON.stringify(proof)}\n`);
}

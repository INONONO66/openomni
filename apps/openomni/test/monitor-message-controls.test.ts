import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Bus, ToolRefused } from "@openomni/agent";
import { ActorRegistry, SessionHandleStore, Storage } from "@openomni/ledger";
import { Gateway } from "@openomni/protocol";
import { createAlarmWorker } from "../src/composition/alarm-worker";
import { monitorTool } from "../src/tools/mutation/monitor";
import { messageFixture } from "./helpers/message-fixture";

function alarmStore() {
  const alarms = Storage.get().alarms;
  if (alarms === undefined) throw new Error("fixture alarm storage missing");
  return alarms;
}

for (const status of ["armed", "fired"] as const) {
  for (const op of ["cancel", "rearm"] as const) {
    test(`monitor refuses ${op} of a real ${status} message deadline; scans survive SQLite reopen`, () =>
      Storage.withIsolation(async () => {
        const fixture = messageFixture("resident", {
          deliveryRoutes: new Map([["ws", async () => ({ value: "accepted" as const })]]),
          grants: () => [
            { id: "grant", senderId: "sender", targetActorId: "peer", operations: ["awaited"] },
          ],
          budgets: () => [
            {
              id: "budget",
              targetActorId: "peer",
              maxPerWindow: 10,
              windowMs: 1000,
              cooldownMs: 0,
            },
          ],
        });
        ActorRegistry.registerIdentity({ id: "peer", kind: "human", trustTier: "owner" });
        ActorRegistry.registerEndpoint({
          id: "ws:peer",
          actorId: "peer",
          channel: "ws",
          externalId: "peer",
        });
        let at = 100;
        const errors: Error[] = [];
        const observations: Gateway.MessageObservation[] = [];
        const timedOut = Promise.withResolvers<void>();
        const bound = AbortSignal.timeout(5000);
        const abort = () => timedOut.reject(new Error("message timeout observation missing"));
        bound.addEventListener("abort", abort, { once: true });
        const unsubscribe = Bus.subscribe(Gateway.MessageObserved, (event) => {
          observations.push(event);
          if (event.kind === "message.timed_out") timedOut.resolve();
        });
        const makeWorker = () =>
          createAlarmWorker({
            alarms: alarmStore(),
            observations: Bus,
            clock: () => at,
            schedule: () => () => undefined,
            wake: async () => undefined,
            failure: (error) => errors.push(error),
          });
        let worker = makeWorker();
        try {
          const sent = await fixture.send({
            to: { kind: "actor", actorId: "peer" },
            type: "message",
            content: "question",
            deadline: 200,
          });
          expect(sent.isError).not.toBe(true);
          const alarm = alarmStore().due(200)[0];
          if (alarm === undefined) throw new Error("message admission did not arm its deadline");
          expect(alarm.kind).toBe("at");
          worker.start();
          if (status === "fired") {
            at = 200;
            worker.tick();
          }
          const before = alarmStore().get(alarm.id);
          expect(before?.status).toBe(status);
          const tree = SessionHandleStore.tree("sender");
          const inbox = SessionHandleStore.inboxRows("sender");
          await expect(
            monitorTool.execute(
              { operation: { op, alarmId: alarm.id } },
              {
                sessionId: "sender",
                turnId: "turn",
                callId: "control",
                signal: new AbortController().signal,
              },
            ),
          ).rejects.toThrow(ToolRefused);
          expect(alarmStore().get(alarm.id)).toEqual(before);
          expect(SessionHandleStore.tree("sender")).toEqual(tree);
          expect(SessionHandleStore.inboxRows("sender")).toEqual(inbox);

          // A refused control must preserve both the pending timeout and shared scan.
          expect(
            alarmStore().arm({
              id: "later-alarm",
              sessionId: "sender",
              kind: "at",
              fireAt: 201,
            }),
          ).toBeDefined();
          at = 201;
          worker.tick();
          worker.tick();
          expect(alarmStore().get(alarm.id)?.status).toBe("fired");
          expect(alarmStore().get("later-alarm")?.status).toBe("fired");
          await timedOut.promise;
          expect(observations.filter((event) => event.kind === "message.timed_out")).toHaveLength(
            1,
          );
          expect(SessionHandleStore.inboxRows("sender")).toHaveLength(2);

          expect(
            alarmStore().arm({
              id: "reopen-alarm",
              sessionId: "sender",
              kind: "at",
              fireAt: 202,
            }),
          ).toBeDefined();
          await worker.close();
          Storage.reset();
          Storage.initialize({ dbPath: fixture.dbPath });
          worker = makeWorker();
          at = 202;
          worker.start();
          worker.tick();
          expect(alarmStore().get(alarm.id)).toMatchObject({ status: "fired", epoch: 1 });
          expect(alarmStore().get("reopen-alarm")?.status).toBe("fired");
          expect(SessionHandleStore.inboxRows("sender")).toHaveLength(3);
          expect(errors).toEqual([]);
        } finally {
          await worker.close();
          unsubscribe();
          bound.removeEventListener("abort", abort);
          Storage.reset();
          Bus.reset();
          rmSync(fixture.directory, { recursive: true, force: true });
        }
      }));
  }
}

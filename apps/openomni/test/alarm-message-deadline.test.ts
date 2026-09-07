import { expect, test } from "bun:test";
import { Storage } from "@openomni/ledger";
import { Alarm, Gateway } from "@openomni/protocol";
import { alarmFixture } from "./helpers/alarm";

for (const replyFirst of [false, true]) {
  test(`live alarm band preserves the message ${replyFirst ? "answer" : "timeout"} winner`, () =>
    Storage.withIsolation(async () => {
      const fixture = alarmFixture();
      const observations: Gateway.MessageObservation[] = [];
      const unsubscribe = fixture.events.subscribe(Gateway.MessageObserved, (event) => {
        observations.push(event);
      });
      try {
        expect(
          fixture.storage.actions.append(
            {
              id: "request-action",
              sessionId: "monitor-session",
              parentId: null,
              kind: "message",
              intent: { encodingVersion: 1, value: { messageId: "request" } },
              effect: { encodingVersion: 1, value: { state: "open" } },
              irreversible: true,
              ts: 1000,
            },
            0,
          ),
        ).toBeDefined();
        fixture.storage.alarms.arm({
          id: "request-action:deadline",
          sessionId: "monitor-session",
          kind: "at",
          fireAt: 1050,
          spec: {
            encodingVersion: 1,
            value: Alarm.MessageDeadline.parse({
              kind: "message_deadline",
              messageId: "request",
              sourceActionId: "request-action",
              createdAt: 1000,
              generation: { toolsGeneration: 0, systemHash: "", policyGeneration: 1 },
            }),
          },
        });
        fixture.worker.start();
        fixture.advance(1049);
        fixture.worker.tick();
        expect(fixture.rows()).toEqual([]);
        if (replyFirst) {
          fixture.storage.inbox.commit({
            id: "reply",
            sessionId: "monitor-session",
            kind: "prompt",
            content: "answer",
            parentActionId: null,
            createdAt: 1049,
            origin: {
              encodingVersion: 1,
              value: {
                kind: "external_reply",
                messageId: "request",
                sourceActionId: "request-action",
                replyTo: "request",
              },
            },
          });
        }
        fixture.advance(1050);
        fixture.worker.tick();
        fixture.worker.tick();
        expect(
          fixture.storage.actions
            .tree("monitor-session")
            .filter((action) => action.id === "request-action:answer")
            .map((action) => action.effect.value),
        ).toEqual([{ state: replyFirst ? "answered" : "timed_out" }]);
        expect(fixture.rows()).toHaveLength(1);
        expect(fixture.rows()[0]?.id).toBe(replyFirst ? "reply" : "request-action:timeout");
        if (!replyFirst) {
          expect(fixture.rows()[0]?.content).toBe(
            JSON.stringify({ type: "timeout", messageId: "request", replyTo: "request" }),
          );
          expect(fixture.wakes).toEqual(["monitor-session"]);
        } else expect(fixture.wakes).toEqual([]);
        await fixture.close();
        expect(observations.filter((event) => event.kind === "message.timed_out")).toHaveLength(
          replyFirst ? 0 : 1,
        );
        expect(fixture.errors).toEqual([]);
      } finally {
        unsubscribe();
        await fixture.close();
      }
    }));
}

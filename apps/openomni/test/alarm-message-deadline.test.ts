import { expect, test } from "bun:test";
import { createSessionRequests } from "@openomni/agent";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { canonicalDigest, Gateway } from "@openomni/protocol";
import { alarmFixture } from "./helpers/alarm";

for (const replyFirst of [false, true]) {
  test(`live alarm band preserves the request ${replyFirst ? "answer" : "timeout"} winner`, () =>
    Storage.withIsolation(async () => {
      const fixture = alarmFixture();
      const observations: Gateway.MessageObservation[] = [];
      const timedOut = Promise.withResolvers<void>();
      const signal = AbortSignal.timeout(5000);
      const abort = () => timedOut.reject(new Error("request timeout observation missing"));
      if (!replyFirst) signal.addEventListener("abort", abort, { once: true });
      const unsubscribe = fixture.events.subscribe(Gateway.MessageObserved, (event) => {
        observations.push(event);
        if (event.kind === "message.timed_out") timedOut.resolve();
      });
      let at = 1000;
      const requests = createSessionRequests({ observations: fixture.events, clock: () => at });
      try {
        SessionHandleStore.materialize({
          id: "request-session",
          parentId: null,
          role: "resident",
          tools: [],
          system: { preset: "", blocks: [] },
          policyGeneration: 1,
          actionId: "configure-request",
          at,
        });
        expect(
          fixture.storage.actions.append(
            {
              id: "request-action",
              sessionId: "request-session",
              parentId: "configure-request",
              kind: "message",
              intent: {
                encodingVersion: 1,
                value: {
                  phase: "intent",
                  value: { messageId: "request" },
                  effectHash: canonicalDigest({}),
                },
              },
              effect: { encodingVersion: 1, value: { phase: "pending" } },
              irreversible: true,
              ts: at,
            },
            SessionHandleStore.row("request-session").revision,
          ),
        ).toBeDefined();
        const request = requests.open({
          requestId: "request-action",
          sessionId: "request-session",
          expectedResponders: ["peer"],
          correlation: {},
          allowedActions: ["report_result"],
          resolution: "first",
          threshold: 1,
          deadline: 1050,
          at,
        });
        expect(fixture.storage.alarms.get("request-action:deadline")).toMatchObject({
          kind: "at",
          fireAt: 1050,
          status: "armed",
        });
        fixture.worker.start();
        at = 1049;
        fixture.advance(at);
        fixture.worker.tick();
        expect(SessionHandleStore.inboxRows("request-session")).toEqual([]);
        if (replyFirst) {
          expect(
            await requests.answer({
              inputId: "reply",
              requestId: request.requestId,
              sessionId: request.sessionId,
              receivedAt: at,
              principal: { kind: "actor", principalId: "peer", evidenceId: "reply" },
              bindingDigest: request.bindingDigest,
              inputHash: request.inputHash,
              effectHash: request.effectHash,
              generation: request.generation,
              toolsHash: request.toolsHash,
              domainRevisions: {},
              decision: "reply",
              allowedAction: "report_result",
              content: "answer",
            }),
          ).toBe("resolved");
        }
        at = 1050;
        fixture.advance(at);
        fixture.worker.tick();
        fixture.worker.tick();
        expect(SessionHandleStore.requestById(request.requestId)?.state).toBe(
          replyFirst ? "resolved" : "expired",
        );
        expect(
          fixture.storage.actions
            .tree("request-session")
            .filter((action) => action.id === "request-action:resolution"),
        ).toHaveLength(1);
        expect(SessionHandleStore.inboxRows("request-session")).toHaveLength(replyFirst ? 1 : 0);
        expect(fixture.storage.alarms.due(at)).toEqual([]);
        if (!replyFirst) await timedOut.promise;
        expect(observations.filter((event) => event.kind === "message.timed_out")).toHaveLength(
          replyFirst ? 0 : 1,
        );
        expect(fixture.errors).toEqual([]);
      } finally {
        signal.removeEventListener("abort", abort);
        unsubscribe();
        await fixture.close();
      }
    }));
}

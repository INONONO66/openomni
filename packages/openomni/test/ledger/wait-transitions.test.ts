import { describe, expect, test } from "bun:test";
import { createWaitReducer, type WaitProjectionV1 } from "../../src/ledger/reducers/wait.js";
import {
  createWaitTransitionFamily,
  type WaitTransitionCommandV1,
} from "../../src/ledger/transitions/wait.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const responderA = { version: "wait-responder-ref-v1", actorId: "actor-a" } as const;
const responderB = { version: "wait-responder-ref-v1", actorId: "actor-b" } as const;
const opened = {
  version: "wait.opened.v1",
  waitId: "wait-1",
  ownerRef: { version: "wait-owner-ref-v1", kind: "workItem", id: "work-1" },
  expectedResponders: [responderA, responderB],
  correlation: { version: "wait-correlation-v1", tokenHash: "c".repeat(64) },
  allowedActions: ["report_result", "ask_clarification"],
  resolutionPolicy: "quorum-with-partial-deadline",
  quorum: { version: "wait-quorum-v1", required: 2, total: 2 },
  status: "open",
  deadline: 100,
  partial: false,
  followUpWindow: 20,
  attempt: {
    version: "attempt-ref-v1",
    workItemId: "work-1",
    attemptId: "attempt-1",
    attemptSeq: 1,
  },
} as const;

const family = createWaitTransitionFamily();
const reducer = createWaitReducer();

function command<T extends WaitTransitionCommandV1>(value: T): T {
  return value;
}

function committed(state: WaitProjectionV1, input: WaitTransitionCommandV1) {
  const result = family.apply(state, input);
  expect(result.status).toBe("committed");
  if (result.status !== "committed") throw new Error(result.reason);
  return result;
}

function open(): ReturnType<typeof committed> {
  return committed(
    reducer.initial(),
    command({ operationId: "WT-01", requestId: "open", observedAtDbMs: 1, opened }),
  );
}

function response(
  operationId: "WT-02" | "WT-03",
  requestId: string,
  responder: typeof responderA | typeof responderB,
  transportId: string,
  responseDigest: string,
) {
  return command({
    operationId,
    requestId,
    observedAtDbMs: 10,
    response: {
      responder,
      transportId,
      responseDigest,
      action: "report_result",
      payloadRef: `artifact:${transportId}`,
    },
  });
}

describe("WT-01..15 durable Wait transition family", () => {
  test("opens one Wait and rejects replacement creation", () => {
    const result = open();
    expect(result.state).toMatchObject({ waitId: "wait-1", status: "open" });
    expect(
      family.apply(
        result.state,
        command({ operationId: "WT-01", requestId: "again", observedAtDbMs: 2, opened }),
      ),
    ).toMatchObject({ status: "rejected", reason: "wait_not_absent" });
  });

  test("records below quorum then atomically resolves first threshold with recoverable dispatch", () => {
    const first = committed(
      open().state,
      response("WT-02", "response-a", responderA, "transport-a", digestA),
    );
    expect(first.state.responseEventIds).toEqual(["response-a:1"]);

    const settled = committed(
      first.state,
      response("WT-03", "response-b", responderB, "transport-b", digestB),
    );
    expect(settled.events.map(({ event }) => event.version)).toEqual([
      "wait.response_recorded.v1",
      "wait.resolved.v1",
      "wait-dispatch-pending-v1",
    ]);
    expect(settled.state).toMatchObject({ status: "resolved" });
    expect(settled.state.pendingDispatches).toEqual([
      expect.objectContaining({
        dispatchId: "wait:wait-1:threshold",
        responseEventIds: ["response-a:1", "response-b:1"],
      }),
    ]);
    expect(
      family.apply(
        settled.state,
        response("WT-03", "too-late", responderB, "transport-c", digestA),
      ),
    ).toMatchObject({ status: "rejected" });
  });

  test("makes duplicate transport outcomes digest-stable and conflict deterministic", () => {
    const state = committed(
      open().state,
      response("WT-02", "response-a", responderA, "transport-a", digestA),
    ).state;
    expect(
      family.apply(
        state,
        command({
          operationId: "WT-04",
          requestId: "duplicate",
          observedAtDbMs: 11,
          transportId: "transport-a",
          responseDigest: digestA,
        }),
      ),
    ).toMatchObject({ status: "no_commit", outcome: "duplicate" });
    expect(
      family.apply(
        state,
        command({
          operationId: "WT-04",
          requestId: "conflict",
          observedAtDbMs: 11,
          transportId: "transport-a",
          responseDigest: digestB,
        }),
      ),
    ).toMatchObject({ status: "rejected", reason: "transport_digest_conflict" });
  });

  test("stages sorted ambiguity and only selects a revalidated candidate once", () => {
    const staged = committed(
      open().state,
      command({
        operationId: "WT-05",
        requestId: "amb",
        observedAtDbMs: 4,
        candidateWaitIds: ["wait-2", "wait-1"],
        transportId: "transport-x",
        responseDigest: digestA,
      }),
    );
    expect(staged.events[0]?.event).toMatchObject({ candidateWaitIds: ["wait-1", "wait-2"] });
    expect(
      family.apply(
        staged.state,
        command({
          operationId: "WT-06",
          requestId: "bad-select",
          observedAtDbMs: 5,
          ambiguityEventId: "amb:1",
          selectedWaitId: "wait-1",
          authorityRevalidated: false,
        }),
      ),
    ).toMatchObject({ status: "rejected", reason: "authority_not_revalidated" });
    const selected = committed(
      staged.state,
      command({
        operationId: "WT-06",
        requestId: "select",
        observedAtDbMs: 5,
        ambiguityEventId: "amb:1",
        selectedWaitId: "wait-1",
        authorityRevalidated: true,
      }),
    );
    expect(selected.state.selectedAmbiguityEventIds.has("amb:1")).toBe(true);
  });

  test("supports deadline partial resolution, resume intent, follow-up retention, and restart fold", () => {
    const partialState = committed(
      open().state,
      response("WT-02", "response-a", responderA, "transport-a", digestA),
    ).state;
    const resolved = committed(
      partialState,
      command({
        operationId: "WT-10",
        requestId: "partial",
        observedAtDbMs: 101,
        partialAllowed: true,
      }),
    );
    expect(resolved.state.resolution).toMatchObject({
      partial: true,
      responseEventIds: ["response-a:1"],
    });

    const resumed = committed(
      resolved.state,
      command({
        operationId: "WT-13",
        requestId: "resume",
        observedAtDbMs: 102,
        attempt: opened.attempt,
      }),
    );
    expect(resumed.state.effectIntents[0]).toMatchObject({
      kind: "resume",
      effectId: "wait:wait-1:resume:attempt-1",
    });

    const followed = committed(
      resumed.state,
      command({
        operationId: "WT-07",
        requestId: "follow",
        observedAtDbMs: 110,
        response: {
          responder: responderB,
          transportId: "follow-1",
          responseDigest: digestB,
          payloadRef: "artifact:follow",
        },
      }),
    );
    const closed = committed(
      followed.state,
      command({ operationId: "WT-15", requestId: "close-followups", observedAtDbMs: 122 }),
    );
    expect(closed.state.followUpEventIds).toEqual(["follow:1"]);

    const allEvents = [
      ...open().events,
      ...committed(
        open().state,
        response("WT-02", "response-a", responderA, "transport-a", digestA),
      ).events,
    ];
    const rebuilt = reducer.fold(allEvents);
    expect(rebuilt.responseEventIds).toEqual(["response-a:1"]);
    expect(rebuilt.status).toBe("open");
  });

  test("closes empty follow-ups and rejects late responses without mutation", () => {
    const first = committed(
      open().state,
      response("WT-02", "response-a", responderA, "transport-a", digestA),
    );
    const resolved = committed(
      first.state,
      response("WT-03", "response-b", responderB, "transport-b", digestB),
    );
    const late = family.apply(
      resolved.state,
      command({
        operationId: "WT-11",
        requestId: "late",
        observedAtDbMs: 111,
        transportId: "late-1",
        responseDigest: digestA,
      }),
    );
    expect(late).toMatchObject({
      status: "no_commit",
      outcome: "late_rejected",
      state: resolved.state,
    });
    expect(
      committed(
        resolved.state,
        command({ operationId: "WT-14", requestId: "close", observedAtDbMs: 31 }),
      ).state.followUpsClosedAtDbMs,
    ).toBe(31);
  });

  test("cancels, expires, and emits stable reminder delivery intents", () => {
    const reminded = committed(
      open().state,
      command({
        operationId: "WT-12",
        requestId: "remind-1",
        observedAtDbMs: 20,
        responder: responderA,
      }),
    );
    expect(reminded.events.map(({ event }) => event.version)).toEqual([
      "wait.reminder_requested.v1",
      "wait-effect-intent-v1",
    ]);
    expect(reminded.state.effectIntents[0]?.effectId).toBe("wait:wait-1:reminder:actor-a\0:1");
    expect(
      committed(
        reminded.state,
        command({
          operationId: "WT-08",
          requestId: "cancel",
          observedAtDbMs: 21,
          reason: "owner cancelled",
        }),
      ).state.status,
    ).toBe("cancelled");
    expect(
      committed(
        open().state,
        command({ operationId: "WT-09", requestId: "expire", observedAtDbMs: 101 }),
      ).state.status,
    ).toBe("expired");
  });
});

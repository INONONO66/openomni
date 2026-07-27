import { describe, expect, test } from "bun:test";
import type { Dispatch } from "@openomni/protocol";
import {
  createResidentInboundWaitHandler,
  type ResidentInboundWaitLedgerService,
} from "../../src/bootstrap/resident-inbound-wait";

const attempt = {
  workItemId: "work-1",
  attemptId: "attempt-1",
  attemptSeq: 1,
  parentSessionId: "resident-session",
  status: "running",
};

function fixture() {
  const waits = new Map<string, { waitId: string; correlation: Dispatch.Correlation }>();
  const opens: string[] = [];
  const resumes: string[] = [];
  const cancellations: string[] = [];
  const submissions: Dispatch.Input[] = [];
  const settlements: boolean[] = [];
  const lifecycle: ResidentInboundWaitLedgerService = {
    queries: {
      attemptByExecution: async () => attempt,
    },
    commands: {
      async openResidentAsk(input) {
        const existing = waits.get(input.requestId);
        if (existing) return existing;
        opens.push(input.requestId);
        const wait = {
          waitId: input.requestId,
          correlation: {
            endpointId: "resident",
            channelId: `worker:${input.sourceSessionId}:${input.sourceRunId}`,
            tokenHash: `token:${input.requestId}`,
          },
        };
        waits.set(input.requestId, wait);
        return wait;
      },
      async resumeAfterResolvedWait(waitId) {
        resumes.push(waitId);
        return { disposition: "act", binding: {} as never };
      },
      async cancel(waitId) {
        cancellations.push(waitId);
      },
    },
  };
  const handler = createResidentInboundWaitHandler({
    workspaceIdentity: { canonicalRoot: "/workspace" } as never,
    lifecycle,
    settlements: {
      commands: {
        async settleDelivery(input) {
          settlements.push(input.accepted);
        },
      },
    },
    dispatchRuntime: {
      async submit(input) {
        submissions.push(input);
        return {
          dispatchId: "dispatch-1",
          status: "completed",
          output: { output: "Proceed", finishReason: "stop" },
        };
      },
    },
  });
  const params = {
    workerId: "worker-1",
    sessionId: "worker-session",
    runId: "worker-run",
    callId: "ask-request-1",
    payload: "Should I proceed?",
    workspaceRoot: "/workspace",
  };
  return { cancellations, handler, opens, params, resumes, settlements, submissions };
}

describe("resident inbound Wait", () => {
  test("records the Attempt-owned Wait before dispatch and resumes it after resolution", async () => {
    const state = fixture();

    const result = await state.handler(state.params);

    expect(state.opens).toEqual(["ask-request-1"]);
    expect(state.submissions).toHaveLength(1);
    expect(state.submissions[0]).toMatchObject({
      action: "resident.ask",
      correlation: {
        endpointId: "resident",
        channelId: "worker:worker-session:worker-run",
        tokenHash: "token:ask-request-1",
      },
      idempotencyKey: "ask-request-1",
    });
    expect(state.resumes).toEqual(["ask-request-1"]);
    expect(state.cancellations).toEqual([]);
    await result.deliverySettlement?.confirmed();
    expect(state.settlements).toEqual([true]);
    expect({ ...result, deliverySettlement: undefined }).toEqual({
      requestId: "ask-request-1",
      accepted: true,
      output: "Proceed",
      deliverySettlement: undefined,
    });
  });

  test("uses callId as the idempotent kernel request and returns the same Wait on retry", async () => {
    const state = fixture();

    const first = await state.handler(state.params);
    const duplicate = await state.handler(state.params);

    expect(state.opens).toEqual(["ask-request-1"]);
    expect(state.submissions.map((input) => input.idempotencyKey)).toEqual([
      "ask-request-1",
      "ask-request-1",
    ]);
    expect(first.requestId).toBe("ask-request-1");
    expect(duplicate.requestId).toBe(first.requestId);
  });
});

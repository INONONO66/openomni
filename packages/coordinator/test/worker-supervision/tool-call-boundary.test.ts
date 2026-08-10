import { describe, test, expect } from "bun:test";
import { handleWorkerRequest } from "../../src/worker-supervision/supervisor-requests";
import type { ToolCallResult } from "../../src/worker-supervision/supervisor-types";

const AUTH = "right-token";

function makeCtx(over: Record<string, unknown> = {}) {
  let handlerCalls = 0;
  const ctx = {
    authToken: AUTH,
    workerId: 7,
    activeToolCalls: new Map(),
    activeInboundWaitCalls: new Map(),
    toolCallHandler: async (): Promise<ToolCallResult> => {
      handlerCalls += 1;
      return { id: "c", toolCallId: "c", output: "ok" };
    },
    notifyToolCallSettled: async () => undefined,
    ...over,
  };
  return { ctx, handlerCalls: () => handlerCalls };
}

const wellFormed = {
  authToken: AUTH,
  runId: "r",
  sessionId: "s",
  callId: "c",
  tool: "fixture.tool",
  input: {},
};

describe("worker.tool_call boundary (#QB1 BUG2)", () => {
  test("malformed params → typed error frame, never throws across the handler", async () => {
    const { ctx, handlerCalls } = makeCtx();
    let result: unknown;
    // Today `params as ToolCallParams` on undefined throws a TypeError that
    // escapes the handler and crashes the coordinator.
    expect(() =>
      handleWorkerRequest(
        "worker.tool_call",
        undefined,
        (r) => {
          result = r;
        },
        ctx as never,
      ),
    ).not.toThrow();
    await Bun.sleep(5);
    expect(handlerCalls()).toBe(0);
    expect(result).toMatchObject({ isError: true });
  });

  test("wrong authToken → unauthorized rejection, handler not invoked", async () => {
    const { ctx, handlerCalls } = makeCtx();
    let result: unknown;
    handleWorkerRequest(
      "worker.tool_call",
      { ...wellFormed, authToken: "WRONG" },
      (r) => {
        result = r;
      },
      ctx as never,
    );
    await Bun.sleep(5);
    expect(handlerCalls()).toBe(0);
    expect(result).toMatchObject({ isError: true });
  });

  test("well-formed + correct authToken → handler runs, result relayed", async () => {
    const { ctx, handlerCalls } = makeCtx();
    let result: unknown;
    handleWorkerRequest(
      "worker.tool_call",
      { ...wellFormed },
      (r) => {
        result = r;
      },
      ctx as never,
    );
    await Bun.sleep(5);
    expect(handlerCalls()).toBe(1);
    expect(result).toMatchObject({ id: "c", output: "ok" });
  });
});

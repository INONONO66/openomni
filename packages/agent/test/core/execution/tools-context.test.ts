import { describe, expect, it } from "bun:test";
import type { ToolExecutionContext } from "@openomni/protocol";
import { z } from "zod";
import { createDispatcher, defineTool, eraseTool } from "../../../src/index";
import { recordingExecutor } from "../../helpers/compiled-policy";

describe("tool execution context", () => {
  it("forwards per-call cancellation with kernel-owned correlation identity", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    let captured: ToolExecutionContext | undefined;
    const definition = defineTool({
      name: "capture",
      description: "Capture context",
      category: "query",
      input: z.object({}).strict(),
      output: z.string(),
      visibility: { model: ["resident"], cell: ["resident"] },
      execute: async (_input, context) => {
        captured = context;
        context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await aborted.promise;
        return "ok";
      },
      render: (_input, output) => output,
    });
    const { executor } = recordingExecutor();
    const dispatcher = createDispatcher([eraseTool(definition)], { executor });

    const running = dispatcher.execute(
      { id: "call-1", tool: "capture", input: {} },
      { sessionId: "session-call", turnId: "turn-1", signal: controller.signal },
    );
    await entered.promise;
    controller.abort("caller cancelled");
    await running;

    expect(captured).toEqual({
      signal: controller.signal,
      sessionId: "session-call",
      turnId: "turn-1",
      callId: "call-1",
    });
    expect(captured?.signal?.aborted).toBe(true);
  });
  it("never enters a body when the caller already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const definition = defineTool({
      name: "capture",
      description: "Capture context",
      category: "query",
      input: z.object({}).strict(),
      output: z.string(),
      visibility: { model: ["resident"], cell: ["resident"] },
      execute: async () => {
        calls += 1;
        return "unexpected";
      },
      render: (_input, output) => output,
    });
    const { executor } = recordingExecutor();
    const result = await createDispatcher([eraseTool(definition)], { executor }).execute(
      { id: "cancelled", tool: "capture", input: {} },
      { sessionId: "session-call", turnId: "turn", signal: controller.signal },
    );
    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });
});

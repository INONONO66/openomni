import { describe, expect, it } from "bun:test";
import type { ToolExecutionContext } from "@openomni/protocol";
import { z } from "zod";
import { createDispatcher, defineTool, eraseTool } from "../../../src/index";
import { recordingExecutor } from "../../helpers/compiled-policy";

describe("tool execution context", () => {
  it("forwards per-call cancellation with kernel-owned correlation identity", async () => {
    const controller = new AbortController();
    controller.abort("caller cancelled");
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
        return "ok";
      },
      render: (_input, output) => output,
    });
    const { executor } = recordingExecutor();
    const dispatcher = createDispatcher([eraseTool(definition)], { executor });

    await dispatcher.execute(
      { id: "call-1", tool: "capture", input: {} },
      { sessionId: "session-call", turnId: "turn-1", signal: controller.signal },
    );

    expect(captured).toEqual({
      signal: controller.signal,
      sessionId: "session-call",
      turnId: "turn-1",
      callId: "call-1",
    });
    expect(captured?.signal?.aborted).toBe(true);
  });
});

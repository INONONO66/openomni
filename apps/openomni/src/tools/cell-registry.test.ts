import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createCellRegistry } from "./cell-registry";
import { createDispatcher, defineTool, eraseTool } from "@openomni/agent";
import type { Tool, ToolExecutionContext } from "@openomni/protocol";
import { createRunCodeTool, type CellPorts } from "./execution/run-code";

const parent = (signal = new AbortController().signal): ToolExecutionContext => ({
  sessionId: "parent-session",
  turnId: "parent-turn",
  callId: "parent-call",
  signal,
});

function valueTool(name: string, value: string) {
  return eraseTool(
    defineTool({
      name,
      category: "query",
      description: `${name} test tool`,
      input: z.object({}).strict(),
      output: z.object({ value: z.string() }).strict(),
      visibility: { model: ["resident"], cell: ["resident"] },
      execute: async () => ({ value }),
      render: (_args, output) => output.value,
    }),
  );
}

describe("cell registry dispatch", () => {
  it("propagates parent identity and cancellation to an in-flight callback", async () => {
    const controller = new AbortController();
    let started!: (context: ToolExecutionContext) => void;
    const executionStarted = new Promise<ToolExecutionContext>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const contexts: ToolExecutionContext[] = [];
    const definition = eraseTool(
      defineTool({
        name: "wait",
        category: "query",
        description: "Wait for the test signal.",
        input: z.object({}).strict(),
        output: z.object({ done: z.boolean() }).strict(),
        visibility: { model: ["resident"], cell: ["resident"] },
        execute: async (_args, context) => {
          contexts.push(context);
          started(context);
          await mayFinish;
          return { done: true };
        },
        render: () => "done",
      }),
    );
    const registry = createCellRegistry();
    const cellDispatcher = createDispatcher([definition]);
    registry.bind(
      "cell-a",
      (async (call: Tool.Call, context?: Tool.ExecutionContext) =>
        await cellDispatcher.executeCell(call, {
          sessionId: "parent-session",
          turnId: "parent-turn",
          ...(context?.signal === undefined ? {} : { signal: context.signal }),
        })) as never,
      parent(controller.signal),
    );

    const pending = registry.callTool({ cellId: "cell-a", name: "wait", arguments: {} });
    const context = await executionStarted;
    controller.abort();

    expect(context).toMatchObject({ sessionId: "parent-session", turnId: "parent-turn" });
    expect(context.signal).toBe(controller.signal);
    expect(context.signal.aborted).toBe(true);
    finish();
    await pending;

    const second = registry.callTool({ cellId: "cell-a", name: "wait", arguments: {} });
    await executionStarted;
    finish();
    await second;
    expect(contexts[0]?.callId).not.toBe(contexts[1]?.callId);
  });

  it("releases a cell after run_code settles through the dispatcher", async () => {
    const registry = createCellRegistry();
    const privateTool = valueTool("private", "resident");
    let cellId = "";
    const ports: CellPorts = {
      registry,
      defaultMachineId: "machine",
      runCell: async (_machineId, request) => {
        cellId = request.cellId;
        return {
          status: "completed",
          cellId: request.cellId,
          output: { stdout: "done", stderr: "" },
        };
      },
      bindTools: () => undefined,
      tools: () => [privateTool],
      newCellId: () => "settled-cell",
    };
    const dispatcher = createDispatcher([eraseTool(createRunCodeTool(ports))]);

    await dispatcher.execute(
      { id: "run-code", tool: "run_code", input: { code: "1", timeoutMs: 1000 } },
      {
        signal: parent().signal,
        sessionId: "parent-session",
        turnId: "parent-turn",
      },
    );

    expect(await registry.callTool({ cellId, name: "private", arguments: {} })).toEqual({
      status: "failed",
      error: "no tools are bound to cell settled-cell",
    });
  });

  it("keeps each cell on its own dispatcher", async () => {
    const registry = createCellRegistry();
    registry.bind(
      "resident-cell",
      createDispatcher([valueTool("private", "resident")]).executeCell as never,
      parent(),
    );
    registry.bind("worker-cell", createDispatcher([]).executeCell as never, parent());

    expect(
      await registry.callTool({ cellId: "worker-cell", name: "private", arguments: {} }),
    ).toEqual({ status: "failed", error: "unregistered tool: private" });
    expect(
      await registry.callTool({ cellId: "resident-cell", name: "private", arguments: {} }),
    ).toEqual({ status: "completed", value: { value: "resident" } });

    registry.release("resident-cell");
    expect(
      await registry.callTool({ cellId: "resident-cell", name: "private", arguments: {} }),
    ).toEqual({ status: "failed", error: "no tools are bound to cell resident-cell" });
  });
});

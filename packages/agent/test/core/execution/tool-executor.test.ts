import { describe, expect, it } from "bun:test";
import { ToolExecutor } from "../../../src/core/execution/tool-executor";
import type { Tool } from "@openomni/protocol";

function makeCall(tool: string, input: Record<string, unknown> = {}): Tool.Call {
  return { id: crypto.randomUUID(), tool, input };
}

function makeExecutor(
  results: Record<string, string>,
  order?: string[],
): (call: Tool.Call) => Promise<Tool.Result> {
  return async (call) => {
    order?.push(call.tool);
    return {
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: results[call.tool] ?? "ok",
      isError: false,
    };
  };
}

describe("ToolExecutor.executeSequential", () => {
  it("runs tools in input order", async () => {
    const order: string[] = [];
    const calls = [makeCall("tool-1"), makeCall("tool-2"), makeCall("tool-3")];
    const executor = makeExecutor({}, order);

    await ToolExecutor.executeSequential(calls, executor);

    expect(order).toEqual(["tool-1", "tool-2", "tool-3"]);
  });

  it("returns results for all tools", async () => {
    const calls = [makeCall("a"), makeCall("b")];
    const executor = makeExecutor({ a: "result-a", b: "result-b" });

    const results = await ToolExecutor.executeSequential(calls, executor);

    expect(results).toHaveLength(2);
    expect(results[0].output).toBe("result-a");
    expect(results[1].output).toBe("result-b");
  });

  it("isolates errors — failed tool gets error result, others continue", async () => {
    const order: string[] = [];
    const calls = [makeCall("tool-1"), makeCall("tool-2"), makeCall("tool-3")];
    const executor = async (call: Tool.Call): Promise<Tool.Result> => {
      order.push(call.tool);
      if (call.tool === "tool-2") throw new Error("tool-2 failed");
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: "ok",
        isError: false,
      };
    };

    const results = await ToolExecutor.executeSequential(calls, executor);

    expect(order).toEqual(["tool-1", "tool-2", "tool-3"]);
    expect(results[0].isError).toBe(false);
    expect(results[1].isError).toBe(true);
    expect(results[1].output).toContain("tool-2 failed");
    expect(results[2].isError).toBe(false);
  });

  it("guard deny returns error result without calling executor", async () => {
    const executorCalled: string[] = [];
    const calls = [makeCall("tool-a"), makeCall("forbidden"), makeCall("tool-b")];
    const executor = async (call: Tool.Call): Promise<Tool.Result> => {
      executorCalled.push(call.tool);
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: "ok",
        isError: false,
      };
    };

    const results = await ToolExecutor.executeSequential(calls, executor, {
      guard: (name) => (name === "forbidden" ? "deny" : "allow"),
    });

    expect(executorCalled).toEqual(["tool-a", "tool-b"]);
    expect(results[0].isError).toBe(false);
    expect(results[1].isError).toBe(true);
    expect(results[1].output).toContain("Permission denied");
    expect(results[2].isError).toBe(false);
  });

  it("guard require_approval returns approval-required error result", async () => {
    const calls = [makeCall("needs-approval")];
    const executor = makeExecutor({});

    const results = await ToolExecutor.executeSequential(calls, executor, {
      guard: () => "require_approval",
    });

    expect(results[0].isError).toBe(true);
    expect(results[0].output).toContain("Approval required");
  });

  it("per-tool timeout returns error result promptly", async () => {
    const calls = [makeCall("slow-tool")];
    const executor = async (call: Tool.Call): Promise<Tool.Result> => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: "done",
        isError: false,
      };
    };

    const start = Date.now();
    const results = await ToolExecutor.executeSequential(calls, executor, {
      timeout: 100,
    });
    const elapsed = Date.now() - start;

    expect(results[0].isError).toBe(true);
    expect(results[0].output).toContain("timed out");
    expect(elapsed).toBeLessThan(2_000);
  });

  it("returns empty array for empty input", async () => {
    const results = await ToolExecutor.executeSequential([], makeExecutor({}));
    expect(results).toHaveLength(0);
  });
});

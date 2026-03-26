import { describe, expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { ParallelToolExecutor } from "../../../src/core/execution/parallel-tools";

function makeCall(tool: string): Tool.Call {
  return { id: crypto.randomUUID(), tool, input: {} };
}

function makeSpec(name: string, safe?: boolean): Tool.Spec {
  return { name, inputSchema: {}, safe };
}

function makeExecutor(
  delayMs = 0,
  results: Record<string, string> = {},
): (call: Tool.Call) => Promise<Tool.Result> {
  return async (call) => {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return {
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: results[call.tool] ?? `result:${call.tool}`,
      isError: false,
    };
  };
}

describe("ParallelToolExecutor", () => {
  describe("mode: off", () => {
    it("executes all tools sequentially regardless of safe flag", async () => {
      const calls = [makeCall("a"), makeCall("b"), makeCall("c")];
      const specs = [makeSpec("a", true), makeSpec("b", true), makeSpec("c", true)];
      const order: string[] = [];
      const executor = async (call: Tool.Call): Promise<Tool.Result> => {
        order.push(call.tool);
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: "ok",
          isError: false,
        };
      };

      await ParallelToolExecutor.execute(calls, specs, executor, {
        mode: "off",
      });
      expect(order).toEqual(["a", "b", "c"]);
    });
  });

  describe("mode: safe-only", () => {
    it("runs safe tools in parallel and unsafe tools sequentially", async () => {
      const calls = [makeCall("safe-a"), makeCall("unsafe-b"), makeCall("safe-c")];
      const specs = [
        makeSpec("safe-a", true),
        makeSpec("unsafe-b", false),
        makeSpec("safe-c", true),
      ];
      const startTimes: Record<string, number> = {};
      const executor = async (call: Tool.Call): Promise<Tool.Result> => {
        startTimes[call.tool] = Date.now();
        await new Promise((r) => setTimeout(r, 50));
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: "ok",
          isError: false,
        };
      };

      const start = Date.now();
      const results = await ParallelToolExecutor.execute(calls, specs, executor, {
        mode: "safe-only",
      });
      const elapsed = Date.now() - start;

      expect(results).toHaveLength(3);
      expect(elapsed).toBeLessThan(150);
      expect(startTimes["safe-a"]).toBeDefined();
      expect(startTimes["safe-c"]).toBeDefined();
      const safeTimeDiff = Math.abs(startTimes["safe-a"] - startTimes["safe-c"]);
      expect(safeTimeDiff).toBeLessThan(20);
    });

    it("preserves original call order in results", async () => {
      const calls = [makeCall("a"), makeCall("b"), makeCall("c"), makeCall("d")];
      const specs = [
        makeSpec("a", true),
        makeSpec("b", false),
        makeSpec("c", true),
        makeSpec("d", false),
      ];
      const executor = makeExecutor(0, { a: "ra", b: "rb", c: "rc", d: "rd" });

      const results = await ParallelToolExecutor.execute(calls, specs, executor, {
        mode: "safe-only",
      });

      expect(results[0].output).toBe("ra");
      expect(results[1].output).toBe("rb");
      expect(results[2].output).toBe("rc");
      expect(results[3].output).toBe("rd");
    });

    it("treats tools with no spec as unsafe (safe=false by default)", async () => {
      const calls = [makeCall("unknown")];
      const specs: Tool.Spec[] = [];
      const order: string[] = [];
      const executor = async (call: Tool.Call): Promise<Tool.Result> => {
        order.push(call.tool);
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: "ok",
          isError: false,
        };
      };

      const results = await ParallelToolExecutor.execute(calls, specs, executor, {
        mode: "safe-only",
      });
      expect(results).toHaveLength(1);
      expect(order).toEqual(["unknown"]);
    });
  });

  describe("mode: all", () => {
    it("runs all tools in parallel including unsafe ones", async () => {
      const calls = [makeCall("a"), makeCall("b"), makeCall("c")];
      const specs = [makeSpec("a", false), makeSpec("b", false), makeSpec("c", false)];
      const startTimes: number[] = [];
      const executor = async (call: Tool.Call): Promise<Tool.Result> => {
        startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, 50));
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: "ok",
          isError: false,
        };
      };

      const start = Date.now();
      await ParallelToolExecutor.execute(calls, specs, executor, {
        mode: "all",
      });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(120);
    });
  });

  describe("guard integration", () => {
    it("denies tools blocked by guard", async () => {
      const calls = [makeCall("blocked"), makeCall("allowed")];
      const specs = [makeSpec("blocked"), makeSpec("allowed")];
      const executor = makeExecutor();
      const guard = (name: string) => (name === "blocked" ? ("deny" as const) : ("allow" as const));

      const results = await ParallelToolExecutor.execute(calls, specs, executor, {
        mode: "safe-only",
        guard,
      });

      expect(results[0].isError).toBe(true);
      expect(results[0].output).toContain("Permission denied");
      expect(results[1].isError).toBe(false);
    });

    it("returns approval-required error for tools needing approval", async () => {
      const calls = [makeCall("needs-approval")];
      const specs = [makeSpec("needs-approval")];
      const executor = makeExecutor();
      const guard = () => "require_approval" as const;

      const results = await ParallelToolExecutor.execute(calls, specs, executor, {
        mode: "safe-only",
        guard,
      });

      expect(results[0].isError).toBe(true);
      expect(results[0].output).toContain("Approval required");
    });
  });

  describe("error handling", () => {
    it("captures executor errors as error results without throwing", async () => {
      const calls = [makeCall("failing")];
      const specs = [makeSpec("failing")];
      const executor = async (): Promise<Tool.Result> => {
        throw new Error("executor failed");
      };

      const results = await ParallelToolExecutor.execute(calls, specs, executor, {
        mode: "safe-only",
      });
      expect(results[0].isError).toBe(true);
      expect(results[0].output).toBe("executor failed");
    });
  });
});

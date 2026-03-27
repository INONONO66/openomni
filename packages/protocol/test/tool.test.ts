import { describe, test, expect } from "bun:test";
import { Tool } from "../src/tool/index.js";

describe("Tool.StatePending", () => {
  test("parses valid pending state with empty input", () => {
    const state = Tool.StatePending.parse({
      status: "pending",
      input: {},
    });

    expect(state.status).toBe("pending");
    expect(state.input).toEqual({});
  });

  test("rejects missing input", () => {
    expect(() => Tool.StatePending.parse({ status: "pending" })).toThrow();
  });

  test("rejects missing status", () => {
    expect(() => Tool.StatePending.parse({ input: {} })).toThrow();
  });

  test("rejects wrong status", () => {
    expect(() =>
      Tool.StatePending.parse({
        status: "running",
        input: {},
      }),
    ).toThrow();
  });
});

describe("Tool.StateRunning", () => {
  test("parses valid running state with negative start time", () => {
    const state = Tool.StateRunning.parse({
      status: "running",
      input: { task: "demo" },
      time: { start: -5 },
    });

    expect(state.status).toBe("running");
    expect(state.time.start).toBe(-5);
  });

  test("rejects missing time", () => {
    expect(() =>
      Tool.StateRunning.parse({
        status: "running",
        input: {},
      }),
    ).toThrow();
  });

  test("rejects missing input", () => {
    expect(() =>
      Tool.StateRunning.parse({
        status: "running",
        time: { start: 1 },
      }),
    ).toThrow();
  });
});

describe("Tool.StateCompleted", () => {
  test("parses valid completed state with time.end set to 0", () => {
    const state = Tool.StateCompleted.parse({
      status: "completed",
      input: { task: "demo" },
      output: "done",
      title: "Demo Task",
      metadata: {},
      time: { start: 1, end: 0 },
    });

    expect(state.status).toBe("completed");
    expect(state.time.end).toBe(0);
    expect(state.metadata).toEqual({});
  });

  test("rejects missing output", () => {
    expect(() =>
      Tool.StateCompleted.parse({
        status: "completed",
        input: {},
        title: "Demo Task",
        metadata: {},
        time: { start: 1, end: 2 },
      }),
    ).toThrow();
  });

  test("rejects missing title", () => {
    expect(() =>
      Tool.StateCompleted.parse({
        status: "completed",
        input: {},
        output: "done",
        metadata: {},
        time: { start: 1, end: 2 },
      }),
    ).toThrow();
  });

  test("rejects missing time", () => {
    expect(() =>
      Tool.StateCompleted.parse({
        status: "completed",
        input: {},
        output: "done",
        title: "Demo Task",
        metadata: {},
      }),
    ).toThrow();
  });
});

describe("Tool.StateError", () => {
  test("parses valid error state", () => {
    const state = Tool.StateError.parse({
      status: "error",
      input: { task: "demo" },
      error: "failed",
      time: { start: 1, end: 2 },
    });

    expect(state.status).toBe("error");
    expect(state.error).toBe("failed");
  });

  test("rejects missing error", () => {
    expect(() =>
      Tool.StateError.parse({
        status: "error",
        input: {},
        time: { start: 1, end: 2 },
      }),
    ).toThrow();
  });

  test("rejects missing time", () => {
    expect(() =>
      Tool.StateError.parse({
        status: "error",
        input: {},
        error: "failed",
      }),
    ).toThrow();
  });
});

describe("Tool.State", () => {
  test("parses each variant by status", () => {
    expect(
      Tool.State.parse({
        status: "pending",
        input: {},
      }).status,
    ).toBe("pending");

    expect(
      Tool.State.parse({
        status: "running",
        input: {},
        time: { start: 1 },
      }).status,
    ).toBe("running");

    expect(
      Tool.State.parse({
        status: "completed",
        input: {},
        output: "done",
        title: "done",
        metadata: {},
        time: { start: 1, end: 2 },
      }).status,
    ).toBe("completed");

    expect(
      Tool.State.parse({
        status: "error",
        input: {},
        error: "failed",
        time: { start: 1, end: 2 },
      }).status,
    ).toBe("error");
  });

  test("rejects wrong status value", () => {
    expect(() =>
      Tool.State.parse({
        status: "done",
        input: {},
      }),
    ).toThrow();
  });

  test("rejects missing status field", () => {
    expect(() => Tool.State.parse({ input: {} })).toThrow();
  });
});

describe("Tool.Call", () => {
  test("parses valid call", () => {
    const call = Tool.Call.parse({
      id: "call-1",
      tool: "search",
      input: { query: "openomni" },
    });

    expect(call.id).toBe("call-1");
    expect(call.tool).toBe("search");
    expect(call.input).toEqual({ query: "openomni" });
  });

  test("rejects missing id", () => {
    expect(() =>
      Tool.Call.parse({
        tool: "search",
        input: {},
      }),
    ).toThrow();
  });

  test("rejects missing tool", () => {
    expect(() =>
      Tool.Call.parse({
        id: "call-1",
        input: {},
      }),
    ).toThrow();
  });
});

describe("Tool.Result", () => {
  test("parses valid minimal result", () => {
    const result = Tool.Result.parse({
      id: "res-1",
      toolCallId: "call-1",
      output: "ok",
    });

    expect(result.id).toBe("res-1");
    expect(result.toolCallId).toBe("call-1");
    expect(result.output).toBe("ok");
    expect(result.isError).toBeUndefined();
  });

  test("parses valid full result", () => {
    const result = Tool.Result.parse({
      id: "res-1",
      toolCallId: "call-1",
      output: "failed",
      isError: false,
    });

    expect(result.isError).toBe(false);
  });

  test("rejects missing output", () => {
    expect(() =>
      Tool.Result.parse({
        id: "res-1",
        toolCallId: "call-1",
      }),
    ).toThrow();
  });
});

describe("Tool.Spec", () => {
  test("parses valid minimal spec", () => {
    const spec = Tool.Spec.parse({
      name: "search",
      inputSchema: {},
    });

    expect(spec.name).toBe("search");
    expect(spec.inputSchema).toEqual({});
    expect(spec.description).toBeUndefined();
    expect(spec.safe).toBeUndefined();
  });

  test("parses valid full spec", () => {
    const spec = Tool.Spec.parse({
      name: "search",
      description: "Search the workspace",
      inputSchema: { type: "object" },
      safe: true,
    });

    expect(spec.description).toBe("Search the workspace");
    expect(spec.safe).toBe(true);
  });

  test("rejects missing name", () => {
    expect(() =>
      Tool.Spec.parse({
        inputSchema: {},
      }),
    ).toThrow();
  });

  test("rejects missing inputSchema", () => {
    expect(() =>
      Tool.Spec.parse({
        name: "search",
      }),
    ).toThrow();
  });
});

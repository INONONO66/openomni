import { describe, expect, it, beforeEach } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { TodoToolProvider } from "./provider.js";

function makeCall(tool: string, input: Record<string, unknown>): Tool.Call {
  return { id: "call-1", tool, input };
}

describe("TodoToolProvider", () => {
  beforeEach(() => {
    Storage.reset();
  });

  it("todo_write: writes todos and returns current state", async () => {
    const provider = new TodoToolProvider();
    const result = await provider.execute(
      makeCall("todo_write", {
        sessionId: "ses-1",
        todos: [{ content: "Do thing", status: "pending", priority: "high" }],
      }),
    );

    expect(result.isError).toBeUndefined();
    const todos = JSON.parse(result.output);
    expect(todos).toHaveLength(1);
    expect(todos[0].content).toBe("Do thing");
    expect(todos[0].status).toBe("pending");
    expect(todos[0].priority).toBe("high");
    expect(todos[0].position).toBe(0);
    expect(todos[0].sessionId).toBe("ses-1");
    expect(typeof todos[0].id).toBe("string");
  });

  it("todo_write: replaces existing todos (not appends)", async () => {
    const provider = new TodoToolProvider();

    await provider.execute(
      makeCall("todo_write", {
        sessionId: "ses-2",
        todos: [
          { content: "First", status: "pending", priority: "high" },
          { content: "Second", status: "pending", priority: "low" },
        ],
      }),
    );

    const result = await provider.execute(
      makeCall("todo_write", {
        sessionId: "ses-2",
        todos: [{ content: "Only this", status: "in_progress", priority: "medium" }],
      }),
    );

    expect(result.isError).toBeUndefined();
    const todos = JSON.parse(result.output);
    expect(todos).toHaveLength(1);
    expect(todos[0].content).toBe("Only this");
    expect(todos[0].status).toBe("in_progress");
  });

  it("todo_write: handles empty todos array", async () => {
    const provider = new TodoToolProvider();

    await provider.execute(
      makeCall("todo_write", {
        sessionId: "ses-3",
        todos: [{ content: "Something", status: "pending", priority: "high" }],
      }),
    );

    const result = await provider.execute(
      makeCall("todo_write", {
        sessionId: "ses-3",
        todos: [],
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual([]);
  });
});

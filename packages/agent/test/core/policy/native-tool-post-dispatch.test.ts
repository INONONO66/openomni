import { describe, expect, it, mock } from "bun:test";
import { createDispatcher, defineTool, type ToolPostPolicy } from "../../../src/index";
import { z } from "zod";

function tool(value: () => Promise<object>) {
  return defineTool({
    name: "account",
    description: "Read an account",
    category: "query",
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ id: z.string(), secret: z.string().optional() }).strict(),
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: value,
    render: (_args, result) => JSON.stringify(result),
  });
}

const context = {
  sessionId: "session-1",
  turnId: "turn-1",
  callId: "call-1",
  signal: new AbortController().signal,
};

function call() {
  return { id: "call-1", tool: "account", input: { id: "a-1" } };
}

describe("typed native tool post dispatch", () => {
  it("does not invoke post policy for invalid raw output", async () => {
    const post = mock<ToolPostPolicy>(async ({ output }) => output);
    const dispatcher = createDispatcher([tool(async () => ({ id: 1 }))], { post });

    const result = await dispatcher.execute(call(), context);

    expect(post).toHaveBeenCalledTimes(0);
    expect(result).toMatchObject({ isError: true, errorKind: "invalid_output" });
    expect(result.output).toBe("account produced invalid output");
  });

  it("passes parsed typed output to post policy and splits model/cell returns", async () => {
    const post = mock<ToolPostPolicy>(async ({ output }) => output);
    const definition = tool(async () => ({ id: "a-1", secret: "token" }));
    const dispatcher = createDispatcher([definition], { post });

    const model = await dispatcher.execute(call(), context);
    const cell = await dispatcher.executeCell(call(), context);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[0].output).toEqual({ id: "a-1", secret: "token" });
    expect(model.output).toBe('{"id":"a-1","secret":"token"}');
    expect(cell.output).toEqual({ id: "a-1", secret: "token" });
  });

  it("fails invalid_output when a named post transform breaks the output schema", async () => {
    const post: ToolPostPolicy = async () => ({ transform: "redact", paths: ["id"] });
    const dispatcher = createDispatcher([tool(async () => ({ id: "a-1", secret: "token" }))], {
      post,
    });

    const result = await dispatcher.execute(call(), context);

    expect(result).toMatchObject({ isError: true, errorKind: "invalid_output" });
    expect(result.output).toBe("account produced invalid output");
  });
});

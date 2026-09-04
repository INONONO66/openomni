import { describe, expect, it } from "bun:test";
import {
  createDispatcher,
  defineTool,
  eraseTool,
  sessionTool,
  ToolRefused,
  toolInputSchema,
  toolSpec,
} from "../src/index";
import type { Executor } from "../src/executor";
import { z } from "zod";

const executor: Executor = {
  async run(_request, body) {
    return { terminal: "executed", value: await body() };
  },
};

function dispatcher(definitions: Parameters<typeof createDispatcher>[0]) {
  return createDispatcher(definitions, { executor });
}

function definition(options: {
  readonly name?: string;
  readonly category?: "query" | "execution";
  readonly execute?: () => Promise<string>;
  readonly render?: (value: string) => string;
}) {
  return defineTool({
    name: options.name ?? "echo",
    description: "Echo a value",
    category: options.category ?? "query",
    input: z.object({ value: z.string() }).strict(),
    output: z.string(),
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: options.execute ?? (async () => "ok"),
    render: (_input, value) => options.render?.(value) ?? value,
  });
}

const context = { sessionId: "session-1", turnId: "turn-1" };
const call = { id: "call-1", tool: "echo", input: { value: "input" } };

describe("tool dispatcher public contract", () => {
  it("rejects empty metadata and non-object input schemas", () => {
    expect(() => definition({ name: " " })).toThrow();
    expect(() =>
      defineTool({
        name: "scalar",
        description: "Scalar input",
        category: "query",
        input: z.string(),
        output: z.string(),
        visibility: { model: ["resident"], cell: [] },
        execute: async (value) => value,
        render: (_input, value) => value,
      }),
    ).toThrow();
    expect(() =>
      defineTool({
        name: "described",
        description: " ",
        category: "query",
        input: z.object({}),
        output: z.string(),
        visibility: { model: [], cell: [] },
        execute: async () => "ok",
        render: (_input, value) => value,
      }),
    ).toThrow();
  });

  it("projects model and session specifications from definitions", () => {
    const query = definition({});
    const execution = definition({ name: "run", category: "execution" });

    expect(toolInputSchema(eraseTool(query))).toMatchObject({ type: "object" });
    expect(toolSpec(eraseTool(query))).toMatchObject({ name: "echo", safe: true, placement: "host" });
    expect(toolSpec(eraseTool(execution))).toMatchObject({ name: "run", safe: false });
    expect(sessionTool(eraseTool(execution))).toMatchObject({ name: "run", category: "execution" });
  });

  it("classifies unknown tools and invalid inputs without invoking a tool", async () => {
    let executions = 0;
    const dispatch = dispatcher([definition({ execute: () => {
      executions += 1;
      return Promise.resolve("ok");
    } })]);

    const unknown = await dispatch.execute({ ...call, tool: "missing" }, context);
    const invalid = await dispatch.execute({ ...call, input: {} }, context);

    expect(unknown).toMatchObject({ isError: true, errorKind: "unregistered_tool" });
    expect(invalid).toMatchObject({ isError: true, errorKind: "invalid_input" });
    expect(executions).toBe(0);
  });

  it("distinguishes explicit refusal from execution failure", async () => {
    const refused = dispatcher([
      definition({ execute: async () => { throw new ToolRefused("echo", "unavailable"); } }),
    ]);
    const failed = dispatcher([
      definition({ execute: () => Promise.reject(Symbol.for("failure")) }),
    ]);

    expect(await refused.execute(call, context)).toMatchObject({
      isError: true,
      errorKind: "precondition_failed",
    });
    expect(await failed.execute(call, context)).toMatchObject({
      isError: true,
      errorKind: "execution_failed",
    });
  });

  it("returns typed cell output and truncates oversized model output", async () => {
    const output = "x".repeat(40_000);
    const dispatch = dispatcher([
      definition({ execute: async () => output, render: (value) => value }),
    ]);

    const cell = await dispatch.executeCell(call, context);
    const model = await dispatch.execute(call, context);

    expect(cell.output).toBe(output);
    expect(typeof model.output).toBe("string");
    expect(model.output).toHaveLength(32_000);
    expect(model.output).toEndWith("[truncated: 40000 chars]");
  });
});

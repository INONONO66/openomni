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
import { recordingExecutor } from "./helpers/compiled-policy";
import { valueTool } from "./helpers/query-tool";
import { z } from "zod";

function dispatcher(definitions: Parameters<typeof createDispatcher>[0]) {
  return createDispatcher(definitions, { executor: recordingExecutor().executor });
}

function definition(options: {
  readonly name?: string;
  readonly category?: "query" | "execution";
  readonly execute?: () => Promise<string>;
  readonly render?: (value: string) => string;
}) {
  return valueTool({
    name: options.name ?? "echo",
    description: "Echo a value",
    ...(options.category === undefined ? {} : { category: options.category }),
    execute: options.execute ?? (async () => "ok"),
    ...(options.render === undefined ? {} : { render: options.render }),
  });
}

const context = { sessionId: "session-1", turnId: "turn-1" };
const call = { id: "call-1", tool: "echo", input: { value: "input" } };

describe("tool dispatcher public contract", () => {
  it("records admission synchronously and never acts before the commit resolves", async () => {
    const reached = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let bodies = 0;
    const recording = recordingExecutor({
      onCommit: async () => {
        reached.resolve();
        await released.promise;
      },
    });
    const dispatch = createDispatcher(
      [
        definition({
          execute: async () => {
            bodies += 1;
            return "result";
          },
        }),
      ],
      { executor: recording.executor },
    );
    const running = dispatch.execute(call, context);
    expect(recording.committed[0]?.kind).toBe("policy.decision");
    await reached.promise;
    expect(bodies).toBe(0);
    released.resolve();
    expect(await running).toMatchObject({ output: "result" });
    expect(bodies).toBe(1);
  });
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
    expect(toolSpec(eraseTool(query))).toMatchObject({ name: "echo", safe: true });
    expect(toolSpec(eraseTool(query))).not.toHaveProperty("placement");
    expect(toolSpec(eraseTool(execution))).toMatchObject({ name: "run", safe: false });
    expect(sessionTool(eraseTool(execution))).toMatchObject({ name: "run", category: "execution" });
  });

  it("classifies missing tools and invalid inputs without invoking a tool", async () => {
    let executions = 0;
    const dispatch = dispatcher([
      definition({
        execute: () => {
          executions += 1;
          return Promise.resolve("ok");
        },
      }),
    ]);

    const missing = await dispatch.execute({ ...call, tool: "missing" }, context);
    const invalid = await dispatch.execute({ ...call, input: {} }, context);

    expect(missing).toMatchObject({ isError: true, errorKind: "unregistered_tool" });
    expect(invalid).toMatchObject({ isError: true, errorKind: "invalid_input" });
    expect(executions).toBe(0);
  });

  it("distinguishes explicit refusal from execution failure", async () => {
    const refused = dispatcher([
      definition({
        execute: async () => {
          throw new ToolRefused("echo", "unavailable");
        },
      }),
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
    const marker = "\n[truncated: 8054 bytes dropped; 40000 bytes original]";
    expect(model.output).toBe(`${output.slice(0, 32_000 - marker.length)}${marker}`);
  });

  it.each([
    "\u{1F600}".repeat(25_000),
    `a${"\u{1F600}".repeat(25_000)}`,
    "\u00e9".repeat(40_000),
    "\u4e2d".repeat(40_000),
  ])("R3 multibyte truncation reports exactly the omitted UTF-8 bytes without splitting text", async (output) => {
    const dispatch = dispatcher([definition({ execute: async () => output })]);
    const cell = await dispatch.executeCell(call, context);
    const model = await dispatch.execute(call, context);
    expect(cell.output).toBe(output);
    expect(model.isError).toBeUndefined();
    expect(model.output.length).toBeLessThanOrEqual(32_000);
    expect(Buffer.from(model.output, "utf8").toString("utf8")).toBe(model.output);
    const receipt = /\n\[truncated: (\d+) bytes dropped; (\d+) bytes original\]$/.exec(
      model.output,
    );
    expect(receipt).not.toBeNull();
    if (receipt === null) throw new Error("missing byte receipt");
    const prefix = model.output.slice(0, receipt.index);
    expect(output.startsWith(prefix)).toBe(true);
    const dropped = output.slice(prefix.length);
    expect(Number(receipt[1])).toBe(Buffer.byteLength(dropped, "utf8"));
    expect(Number(receipt[2])).toBe(Buffer.byteLength(output, "utf8"));
    expect(Buffer.byteLength(prefix) + Number(receipt[1])).toBe(Number(receipt[2]));
    const nextCodePoint = [...dropped][0];
    expect(nextCodePoint).toBeDefined();
    expect(model.output.length + (nextCodePoint?.length ?? 0)).toBeGreaterThan(32_000);
  });

  it("R3 Unicode boundary keeps the exact prefix and byte marker through the dispatcher", async () => {
    const output = `a${"\u{1F600}".repeat(25_000)}`;
    const dispatch = dispatcher([definition({ execute: async () => output })]);
    const model = await dispatch.execute(call, context);
    expect(model.output).toBe(
      `a${"\u{1F600}".repeat(15_971)}\n[truncated: 36116 bytes dropped; 100001 bytes original]`,
    );
    expect((await dispatch.executeCell(call, context)).output).toBe(output);
  });
});

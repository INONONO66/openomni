import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { defineTool, eraseTool, ToolRefused } from "./define";
import { createDispatcher, MODEL_OUTPUT_MAX_CHARS } from "./dispatch";

type Value = { value: string };
type Rendered = { rendered: string };
function definition(
  options: { execute?: (args: Value) => Promise<Rendered>; output?: z.ZodType<Rendered> } = {},
) {
  return eraseTool(
    defineTool({
      name: "example",
      category: "query",
      description: "An example tool.",
      input: z.object({ value: z.string().min(1) }).strict(),
      output: options.output ?? z.object({ rendered: z.string() }).strict(),
      visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
      execute: options.execute ?? (async ({ value }) => ({ rendered: value })),
      render: (_args, value) => value.rendered,
    }),
  );
}

describe("the core tool dispatcher", () => {
  it("validates input before execution", async () => {
    const result = await createDispatcher([definition()]).execute({
      id: "bad",
      tool: "example",
      input: { value: "" },
    });
    expect(result).toMatchObject({ isError: true, errorClass: "invalid_input" });
    expect(result.output).toStartWith("example refused: value:");
  });
  it("maps ToolRefused and ordinary throws", async () => {
    const refused = await createDispatcher([
      definition({
        execute: async () => {
          throw new ToolRefused("example", "no");
        },
      }),
    ]).execute({ id: "r", tool: "example", input: { value: "x" } });
    expect(refused).toMatchObject({ isError: true, errorClass: "precondition_failed" });
    const failed = await createDispatcher([
      definition({
        execute: async () => {
          throw new Error("boom");
        },
      }),
    ]).execute({ id: "f", tool: "example", input: { value: "x" } });
    expect(failed).toMatchObject({ isError: true, errorClass: "execution_failed" });
  });
  it("validates output", async () => {
    const result = await createDispatcher([
      definition({ output: z.object({ rendered: z.literal("right") }) }),
    ]).execute({ id: "o", tool: "example", input: { value: "wrong" } });
    expect(result).toMatchObject({ isError: true, errorClass: "invalid_output" });
  });
  it("reports unknown tools", async () => {
    expect(
      await createDispatcher([]).execute({ id: "u", tool: "missing", input: {} }),
    ).toMatchObject({ isError: true, errorClass: "unknown_tool" });
  });
  it("caps model output with truncation facts and leaves the cell value untruncated", async () => {
    const dispatcher = createDispatcher([definition()]);
    const text = "x".repeat(MODEL_OUTPUT_MAX_CHARS + 5);
    const call = { id: "long", tool: "example", input: { value: text } };

    const model = await dispatcher.execute(call);
    expect(model.output.length).toBeLessThanOrEqual(MODEL_OUTPUT_MAX_CHARS);
    expect(model.output).toEndWith(`\n[truncated: ${text.length} chars]`);
    expect(model.output).not.toContain("artifact");

    const cell = await dispatcher.executeCell(call);
    expect(cell.output).toEqual({ rendered: text });
  });
});

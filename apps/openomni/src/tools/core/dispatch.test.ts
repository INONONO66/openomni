import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { DelegationOrigin } from "../../delegation/admission";
import type { CatalogPorts } from "./catalog";
import { defineTool, eraseTool, ToolRefused } from "./define";
import { createDispatcher, type CatalogEntry } from "./dispatch";
import { toolSpec } from "./project";

const ORIGIN: DelegationOrigin = { role: "resident", depth: 0, sessionId: "test" };

function entry(options: {
  execute?: (args: { value: string }) => Promise<{ rendered: string }>;
  output?: z.ZodType<{ rendered: string }>;
} = {}): CatalogEntry {
  const definition = defineTool({
    name: "example",
    category: "query",
    description: "An example tool.",
    input: z.object({ value: z.string().min(1) }).strict(),
    output: options.output ?? z.object({ rendered: z.string() }).strict(),
    safe: true,
    execution: { kind: "host" },
    visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] },
    bind: () => options.execute ?? (async ({ value }) => ({ rendered: value })),
    render: (_args, value) => value.rendered,
  });
  const run = definition.bind({} as CatalogPorts, ORIGIN);
  if (run === undefined) throw new Error("test definition did not bind");
  return { spec: toolSpec(definition), definition: eraseTool(definition), run };
}

describe("the core tool dispatcher", () => {
  it("turns central input validation failures into error results", async () => {
    const result = await createDispatcher([entry()]).execute({
      id: "bad-input",
      tool: "example",
      input: { value: "" },
    });

    expect(result.isError).toBe(true);
    expect(result.output).toStartWith("\nexample refused: value:");
  });

  it("maps a domain ToolRefused to an error result", async () => {
    const result = await createDispatcher([
      entry({ execute: async () => { throw new ToolRefused("example", "not available"); } }),
    ]).execute({ id: "refused", tool: "example", input: { value: "x" } });

    expect(result).toMatchObject({ isError: true, output: "example refused: not available" });
  });

  it("isolates an invalid executor output", async () => {
    const result = await createDispatcher([
      entry({ execute: async () => ({ rendered: "wrong" }), output: z.object({ rendered: z.literal("right") }) }),
    ]).execute({ id: "bad-output", tool: "example", input: { value: "x" } });

    expect(result).toMatchObject({ isError: true, output: "example produced invalid output" });
  });

  it("reports an unknown tool", async () => {
    const result = await createDispatcher([]).execute({ id: "unknown", tool: "missing", input: {} });
    expect(result).toMatchObject({ isError: true, output: "unknown tool: missing" });
  });

  it("turns an ordinary thrown error into an error result", async () => {
    const result = await createDispatcher([
      entry({ execute: async () => { throw new Error("executor failed"); } }),
    ]).execute({ id: "thrown", tool: "example", input: { value: "x" } });

    expect(result).toMatchObject({ isError: true, output: "executor failed" });
  });
});

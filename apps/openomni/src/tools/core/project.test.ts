import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { defineTool } from "./define";
import { toolInputSchema, toolSpec } from "./project";

const shared = {
  category: "query" as const,
  description: "A projected tool.",
  output: z.object({ ok: z.boolean() }).strict(),
  visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] } as const,
  execute: async () => ({ ok: true }),
  render: () => "ok",
};

describe("tool schema projection", () => {
  it("derives a strict object schema and core-owned spec constants", () => {
    const definition = defineTool({
      ...shared,
      name: "projected",
      input: z
        .object({ query: z.string().describe("What to find."), limit: z.number().int().optional() })
        .strict(),
    });
    expect(toolInputSchema(definition)).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "What to find." },
        limit: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 },
      },
      required: ["query"],
      additionalProperties: false,
    });
    expect(toolSpec(definition)).toMatchObject({ safe: true, placement: "host" });
  });
  it("rejects a non-object root", () => {
    expect(() =>
      defineTool({
        ...shared,
        name: "invalid-root",
        input: z.union([
          z.object({ a: z.string() }),
          z.object({ b: z.string() }),
        ]) as unknown as z.ZodObject,
      }),
    ).toThrow("input schema root must be an object");
  });
  it("derives unsafe specs from non-query categories", () => {
    const definition = defineTool({
      ...shared,
      category: "execution",
      name: "execute",
      input: z.object({}).strict(),
    });
    expect(toolSpec(definition)).toMatchObject({ safe: false, placement: "host" });
  });
});

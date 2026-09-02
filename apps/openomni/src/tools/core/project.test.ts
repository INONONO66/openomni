import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { defineTool } from "./define";
import { toolInputSchema, toolSpec } from "./project";

const shared = {
  category: "query" as const,
  description: "A projected tool.",
  output: z.object({ ok: z.boolean() }).strict(),
  safe: true,
  visibility: { model: ["resident", "worker"], cell: ["resident", "worker"] } as const,
  bind: () => async () => ({ ok: true }),
  render: () => "ok",
};

describe("tool schema projection", () => {
  it("derives a strict object schema with required fields and descriptions", () => {
    const definition = defineTool({
      ...shared,
      name: "projected",
      input: z.object({ query: z.string().describe("What to find."), limit: z.number().int().optional() }).strict(),
      execution: { kind: "host" },
    });

    const schema = toolInputSchema(definition);
    expect(schema).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "What to find." },
        limit: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 },
      },
      required: ["query"],
      additionalProperties: false,
    });
    expect((schema.properties as Record<string, { description?: string }>).query?.description).toBe(
      "What to find.",
    );
  });

  it("validates every input example at construction time", () => {
    expect(() => defineTool({
      ...shared,
      name: "valid-examples",
      input: z.object({ query: z.string().min(1) }).strict(),
      inputExamples: [{ query: "status" }],
      execution: { kind: "host" },
    })).not.toThrow();

    expect(() => defineTool({
      ...shared,
      name: "invalid-examples",
      input: z.object({ query: z.string().min(1) }).strict(),
      inputExamples: [{ query: "" }],
      execution: { kind: "host" },
    })).toThrow("invalid-examples input example 0 is invalid");
  });

  it("rejects a non-object root", () => {
    expect(() => defineTool({
      ...shared,
      name: "invalid-root",
      input: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]) as unknown as z.ZodObject,
      execution: { kind: "host" },
    })).toThrow("input schema root must be an object");
  });

  it("auto-injects an optional machine selector for machine execution", () => {
    const definition = defineTool({
      ...shared,
      name: "machine-projected",
      input: z.object({ command: z.string() }).strict(),
      execution: { kind: "machine", capability: "shell.exec" },
    });

    const schema = toolInputSchema(definition) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties.machine).toEqual({ type: "string" });
    expect(schema.required).toEqual(["command"]);
    expect(toolSpec(definition).placement).toBe("machine");
  });

  it("lets an explicit wire projection override the derived schema", () => {
    const projection = {
      type: "object",
      properties: { legacy: { type: "string" } },
      required: ["legacy"],
      additionalProperties: false,
    } as const;
    const definition = defineTool({
      ...shared,
      name: "wire-override",
      input: z.object({ modern: z.string() }).strict(),
      execution: { kind: "machine", capability: "legacy.exec" },
      wireProjection: projection,
    });

    expect(toolInputSchema(definition)).toEqual(projection);
  });
});

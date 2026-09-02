import type { Tool } from "@openomni/protocol";
import { z } from "zod";
import type { AnyToolDefinition, ToolDefinition } from "./define";

export const TOOL_PROJECTOR_VERSION = 1;

function withoutDialect(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _dialect, ...projected } = schema;
  return projected;
}

export function toolInputSchema(
  definition: AnyToolDefinition | ToolDefinition<z.ZodObject, z.ZodType>,
): Record<string, unknown> {
  const projected = definition.wireProjection ?? withoutDialect(
    z.toJSONSchema(definition.input, { io: "input", target: "draft-7" }) as Record<string, unknown>,
  );
  if (projected.type !== "object") {
    throw new Error(`${definition.name} input schema root must be an object`);
  }

  if (definition.execution.kind !== "machine") return projected;
  const properties = projected.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    throw new Error(`${definition.name} input schema properties must be an object`);
  }
  if ("machineId" in properties || "machine" in properties) return projected;
  return {
    ...projected,
    properties: { ...properties, machine: { type: "string" } },
  };
}

export function toolSpec(
  definition: AnyToolDefinition | ToolDefinition<z.ZodObject, z.ZodType>,
): Tool.Spec {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: toolInputSchema(definition),
    safe: definition.safe,
    ...(definition.placement === undefined ? {} : { placement: definition.placement }),
    ...(definition.requires === undefined ? {} : { requires: [...definition.requires] }),
  };
}

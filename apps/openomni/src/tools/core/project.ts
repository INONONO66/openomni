import { SessionGeneration, type Tool } from "@openomni/protocol";
import { z } from "zod";
import { toolIsSafe, type AnyToolDefinition, type ToolDefinition } from "./define";

function withoutDialect(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _dialect, ...projected } = schema;
  return projected;
}

export function toolInputSchema(
  definition: AnyToolDefinition | ToolDefinition<z.ZodType, z.ZodType>,
): Record<string, unknown> {
  const projected = withoutDialect(
    z.toJSONSchema(definition.input, { io: "input", target: "draft-7" }) as Record<string, unknown>,
  );
  if (projected.type !== "object") {
    throw new Error(`${definition.name} input schema root must be an object`);
  }
  return projected;
}

export function sessionTool(
  definition: AnyToolDefinition | ToolDefinition<z.ZodType, z.ZodType>,
): SessionGeneration.Tool {
  return SessionGeneration.Tool.parse({
    name: definition.name,
    inputSchema: toolInputSchema(definition),
    category: definition.category,
  });
}

export function toolSpec(
  definition: AnyToolDefinition | ToolDefinition<z.ZodType, z.ZodType>,
): Tool.Spec {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: toolInputSchema(definition),
    safe: toolIsSafe(definition.category),
    placement: "host",
  };
}

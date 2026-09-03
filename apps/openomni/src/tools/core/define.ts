import { z } from "zod";

export type ToolCategory = "query" | "mutation" | "authority" | "execution";
type ToolRole = "resident" | "worker";

export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
}

export interface ToolDefinition<In extends z.ZodType, Out extends z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly input: In;
  readonly output: Out;
  readonly visibility: {
    readonly model: readonly ToolRole[];
    readonly cell: readonly ToolRole[];
  };
  readonly sequential?: true;
  readonly execute: (args: z.output<In>, ctx: ToolExecutionContext) => Promise<z.output<Out>>;
  readonly render: (args: z.output<In>, value: z.output<Out>) => string;
}

/** Type-erased only at the heterogeneous catalog boundary. */
export interface AnyToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly visibility: {
    readonly model: readonly ToolRole[];
    readonly cell: readonly ToolRole[];
  };
  readonly sequential?: true;
  readonly execute: (args: never, ctx: ToolExecutionContext) => Promise<unknown>;
  readonly render: (args: never, value: never) => string;
}

function schemaRoot(definition: Pick<AnyToolDefinition, "input">): Record<string, unknown> {
  return z.toJSONSchema(definition.input, {
    io: "input",
    target: "draft-7",
  }) as Record<string, unknown>;
}

export function defineTool<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
): ToolDefinition<In, Out> {
  if (definition.name.trim() === "") throw new Error("tool name must not be empty");
  if (definition.description.trim() === "") throw new Error("tool description must not be empty");
  if (schemaRoot(eraseTool(definition)).type !== "object") {
    throw new Error(`${definition.name} input schema root must be an object`);
  }
  return definition;
}

export function eraseTool<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
): AnyToolDefinition {
  return definition as unknown as AnyToolDefinition;
}

/** The single owner of the replay-safety derivation. */
export function toolIsSafe(category: ToolCategory): boolean {
  return category === "query";
}

export class ToolRefused extends Error {
  constructor(toolName: string, reason: string) {
    super(`${toolName} refused: ${reason}`);
    this.name = "ToolRefused";
  }
}

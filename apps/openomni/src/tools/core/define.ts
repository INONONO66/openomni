import { z } from "zod";
import type { DelegationOrigin } from "../../delegation/admission";
import type { CatalogPorts } from "./catalog";

export type ToolCategory = "query" | "mutation" | "authority" | "execution";
export type ToolRole = "resident" | "worker";
export type ExecutionLocus =
  | { readonly kind: "host" }
  | { readonly kind: "machine"; readonly capability: string };

export interface ToolDefinition<In extends z.ZodObject, Out extends z.ZodType> {
  readonly name: string;
  readonly category: ToolCategory;
  readonly description: string;
  readonly input: In;
  readonly output: Out;
  readonly safe: boolean;
  readonly execution: ExecutionLocus;
  readonly placement?: "host";
  readonly requires?: readonly string[];
  readonly visibility: {
    readonly model: readonly ToolRole[];
    readonly cell: readonly ToolRole[];
  };
  readonly inputExamples?: readonly unknown[];
  readonly bind: (
    ports: CatalogPorts,
    origin: DelegationOrigin,
  ) => ((args: z.output<In>) => Promise<z.output<Out>>) | undefined;
  readonly render: (args: z.output<In>, value: z.output<Out>) => string;
  readonly wireProjection?: Record<string, unknown>;
}

/** Type-erased only at the heterogeneous catalog boundary. */
export interface AnyToolDefinition {
  readonly name: string;
  readonly category: ToolCategory;
  readonly description: string;
  readonly input: z.ZodObject;
  readonly output: z.ZodType;
  readonly safe: boolean;
  readonly execution: ExecutionLocus;
  readonly placement?: "host";
  readonly requires?: readonly string[];
  readonly visibility: {
    readonly model: readonly ToolRole[];
    readonly cell: readonly ToolRole[];
  };
  readonly inputExamples?: readonly unknown[];
  readonly bind: (
    ports: CatalogPorts,
    origin: DelegationOrigin,
  ) => ((args: never) => Promise<unknown>) | undefined;
  readonly render: (args: never, value: never) => string;
  readonly wireProjection?: Record<string, unknown>;
}

function schemaRoot(definition: Pick<AnyToolDefinition, "input" | "wireProjection">): Record<string, unknown> {
  return definition.wireProjection ?? (z.toJSONSchema(definition.input, {
    io: "input",
    target: "draft-7",
  }) as Record<string, unknown>);
}

export function defineTool<In extends z.ZodObject, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
): ToolDefinition<In, Out> {
  if (definition.name.trim() === "") throw new Error("tool name must not be empty");
  if (definition.description.trim() === "") throw new Error("tool description must not be empty");
  if (schemaRoot(eraseTool(definition)).type !== "object") {
    throw new Error(`${definition.name} input schema root must be an object`);
  }
  for (const [index, example] of (definition.inputExamples ?? []).entries()) {
    try {
      definition.input.parse(example);
    } catch {
      throw new Error(`${definition.name} input example ${index} is invalid`);
    }
  }
  return definition;
}

export function eraseTool<In extends z.ZodObject, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
): AnyToolDefinition {
  return definition as unknown as AnyToolDefinition;
}

export class ToolRefused extends Error {
  constructor(toolName: string, reason: string) {
    super(`${toolName} refused: ${reason}`);
    this.name = "ToolRefused";
  }
}

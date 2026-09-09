import type { Tool } from "@openomni/protocol";
import { jsonSchema, type TextStreamPart, type ToolSet } from "ai";
import { ProviderTransform } from "./transform";
import type { Provider } from ".";

/** Schemas only: execution and authorization remain with the receiving executor. */
export function streamTools(specs: Tool.Spec[], names: string[], model: Provider.Model): ToolSet {
  const cacheOptions = ProviderTransform.anthropicCacheOptions(model);
  return Object.fromEntries(specs.map((spec, index) => [names[index], {
    type: "function" as const,
    description: spec.description,
    inputSchema: jsonSchema(spec.inputSchema),
    ...(index === specs.length - 1 && cacheOptions ? { providerOptions: cacheOptions } : {}),
  }]));
}

/** v6 block boundaries pass through unchanged; only step marker names differ. */
export async function* adaptStream(stream: AsyncIterable<TextStreamPart<ToolSet>>): AsyncGenerator<
  TextStreamPart<ToolSet>
  | (Omit<Extract<TextStreamPart<ToolSet>, { type: "finish-step" }>, "type"> & { type: "step-finish" })
  | { type: "step-start" }
> {
  for await (const event of stream) {
    if (event.type === "finish-step") yield { ...event, type: "step-finish" };
    else if (event.type === "start-step") yield { ...event, type: "step-start" };
    else yield event;
  }
}

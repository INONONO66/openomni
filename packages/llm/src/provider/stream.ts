import { Operational, PlainObjectSchema, type Tool } from "@openomni/protocol";
import {
  jsonSchema,
  stepCountIs,
  type streamText,
  type StopCondition,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { toModelMessages, type SDKMessage } from "../message";
import type { RunInput } from "../run";
import type { getLanguage } from "./sdk";
import { ProviderTransform } from "./transform";
import type { Provider } from ".";

/** Schemas only: execution and authorization remain with the receiving executor. */
function streamTools(specs: Tool.Spec[], names: string[], model: Provider.Model): ToolSet {
  const cacheOptions = ProviderTransform.anthropicCacheOptions(model);
  return Object.fromEntries(
    specs.map((spec, index) => [
      names[index],
      {
        type: "function" as const,
        description: spec.description,
        inputSchema: jsonSchema(spec.inputSchema),
        ...(index === specs.length - 1 && cacheOptions ? { providerOptions: cacheOptions } : {}),
      },
    ]),
  );
}

const ProviderOptions = z.record(z.string(), PlainObjectSchema);

function stopConditions(input: RunInput): StopCondition<ToolSet>[] {
  const conditions: StopCondition<ToolSet>[] = [stepCountIs(1)];
  const threshold = input.yieldAtInputTokens;
  if (threshold !== undefined)
    conditions.push(({ steps }) => (steps[steps.length - 1]?.usage?.inputTokens ?? 0) >= threshold);
  const shouldYield = input.shouldYield;
  if (shouldYield !== undefined) conditions.push(() => shouldYield());
  return conditions;
}

export function streamArguments(
  input: RunInput,
  system: string,
  abortSignal: AbortSignal,
  names: string[],
  model: ReturnType<typeof getLanguage>,
): Parameters<typeof streamText>[0] {
  const cacheOptions = ProviderTransform.anthropicCacheOptions(input.model);
  const systemMessages: SDKMessage[] = system
    ? [{ role: "system", content: system, ...(cacheOptions && { providerOptions: cacheOptions }) }]
    : [];
  return {
    model,
    messages: [...systemMessages, ...toModelMessages(input.messages, input.model)],
    tools: streamTools(input.tools, names, input.model),
    toolChoice: input.toolChoice,
    ...(input.maxTokens === undefined ? {} : { maxOutputTokens: input.maxTokens }),
    maxRetries: 0,
    stopWhen: stopConditions(input),
    onError: ({ error }) => {
      input.events.publish(Operational.Events.Error, {
        traceId: input.trace.traceId,
        time: Date.now(),
        sessionId: input.trace.sessionId,
        component: "llm.stream",
        msg: "streamText error",
        error: String(error),
      });
    },
    abortSignal,
    // Provider namespaces cannot overwrite call-owned arguments.
    ...(input.providerOptions !== undefined && {
      providerOptions: ProviderOptions.parse(input.providerOptions),
    }),
  };
}

/** v6 block boundaries pass through unchanged; only step marker names differ. */
export async function* adaptStream(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
): AsyncGenerator<
  | TextStreamPart<ToolSet>
  | (Omit<Extract<TextStreamPart<ToolSet>, { type: "finish-step" }>, "type"> & {
      type: "step-finish";
    })
  | { type: "step-start" }
> {
  for await (const event of stream) {
    if (event.type === "finish-step") yield { ...event, type: "step-finish" };
    else if (event.type === "start-step") yield { ...event, type: "step-start" };
    else yield event;
  }
}

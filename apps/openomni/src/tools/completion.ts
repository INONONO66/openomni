import { Machine, type ToolExecutionContext } from "@openomni/protocol";
import { z } from "zod";
import { defineTool, ToolRefused } from "@openomni/agent";

/** What one sub-model call asks for: the prompt, and optionally a system text and model id. */
export interface LlmCall {
  readonly prompt: string;
  readonly system?: string;
  /** A model id on the port's configured provider; the port owns that provider's credential. */
  readonly model?: string;
}

/**
 * A one-shot sub-model call, without knowing how the host is composed: a
 * prompt in, the model's text out. Stateless by contract — each call is a
 * fresh completion, so the port carries no history.
 */
export type LlmPort = (call: LlmCall) => Promise<string>;

/** The per-cell call budget: how many sub-model calls one cell may make. */
const MAX_COMPLETION_CALLS = 32;

/** The cell's `completion(prompt, {model?, system?, schema?})`, one prompt per call. */
const Input = Machine.CompletionRequest;

const COMPLETION_TOOL_NAME = "completion";

function schemaInstruction(schema: NonNullable<Machine.CompletionRequest["schema"]>): string {
  return `Answer with one JSON value that satisfies this JSON Schema, and nothing else:\n${JSON.stringify(schema)}`;
}

/** Strip a Markdown code fence a model may wrap its JSON in; the content is what gets validated. */
function unfence(text: string): string {
  const fenced = /^\s*```[a-zA-Z]*\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}

/** The answer as canonical JSON text once it satisfies the schema; otherwise a refusal the cell can catch. */
function conform(answer: string, schema: NonNullable<Machine.CompletionRequest["schema"]>): string {
  const validator = z.fromJSONSchema(schema);
  let checked: ReturnType<typeof validator.safeParse>;
  try {
    checked = validator.safeParse(JSON.parse(unfence(answer)));
  } catch {
    throw new ToolRefused(COMPLETION_TOOL_NAME, `sub-model answer is not JSON: ${answer}`);
  }
  if (!checked.success)
    throw new ToolRefused(
      COMPLETION_TOOL_NAME,
      `sub-model answer does not satisfy the schema: ${checked.error.message}`,
    );
  return JSON.stringify(checked.data);
}

/**
 * Budgets keyed by the cell that spends them. The cell door dispatches with
 * `turnId` = cell id, and one catalog serves every cell of a ports object, so
 * a counter in the tool closure would be one process-wide budget.
 */
function executeCompletion(llm: LlmPort | undefined) {
  const spent = new Map<string, number>();
  return async (input: z.output<typeof Input>, ctx: ToolExecutionContext): Promise<string> => {
    if (llm === undefined)
      throw new ToolRefused(COMPLETION_TOOL_NAME, "sub-model port is not composed");
    const calls = spent.get(ctx.turnId) ?? 0;
    if (calls >= MAX_COMPLETION_CALLS) {
      throw new ToolRefused(
        COMPLETION_TOOL_NAME,
        `the per-cell budget of ${MAX_COMPLETION_CALLS} sub-model calls is spent`,
      );
    }
    spent.set(ctx.turnId, calls + 1);
    const system = systemText(input);
    const answer = await llm({
      prompt: input.prompt,
      ...(system === "" ? {} : { system }),
      ...(input.model === undefined ? {} : { model: input.model }),
    });
    return input.schema === undefined ? answer : conform(answer, input.schema);
  };
}

/** The sub-model's system text: the cell's own system text, then the schema instruction when a schema is given. */
function systemText(input: z.output<typeof Input>): string {
  const parts: string[] = [];
  if (input.system !== undefined) parts.push(input.system);
  if (input.schema !== undefined) parts.push(schemaInstruction(input.schema));
  return parts.join("\n\n");
}

/** Cell-only: batching is the cell's `parallel()`, so the input is one prompt. */
export function createCompletionTool(llm: LlmPort | undefined) {
  return defineTool({
    name: COMPLETION_TOOL_NAME,
    category: "execution",
    description:
      "Ask a sub-model one one-shot, stateless question and return its text. Options: model (an id on the configured provider), system, schema (a JSON Schema the answer must satisfy; the validated JSON text is returned).",
    input: Input,
    output: z.string(),
    visibility: { model: [], cell: ["resident", "worker"] },
    execute: executeCompletion(llm),
    render: (_args, value) => value,
  });
}

import {
  PlainValueSchema,
  type ToolDefinition,
  type ToolExecutionContext,
} from "@openomni/protocol";
import { Effect, flow, Option } from "effect";
import { z } from "zod";
import { ToolBodyFailed } from "./errors";
import { RawToolSlots } from "./executor-raw";

export const ToolBodyOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("timed_out") }).strict(),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    errorKind: z.enum(["precondition_failed", "execution_failed", "invalid_output"]),
  }).strict(),
  z.object({ status: z.literal("success"), output: PlainValueSchema }).strict(),
]);
type ToolBodyOutcome = z.infer<typeof ToolBodyOutcome>;

/** The only async-tool boundary. Register ownership and handlers before entering foreign code. */
export function executeToolBody<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
  input: z.output<In>,
  context: ToolExecutionContext,
  timeoutMs: number | undefined,
): Effect.Effect<ToolBodyOutcome, ToolBodyFailed, RawToolSlots> {
  return Effect.gen(function* () {
    const slots = yield* RawToolSlots;
    const execution = Effect.async<ToolBodyOutcome, ToolBodyFailed>((resume, signal) => {
      const settle = slots.open();
      const controller = new AbortController();
      const scopedContext = {
        ...context,
        signal: AbortSignal.any([context.signal, signal, controller.signal]),
      };
      const raw = Promise.resolve().then(() => definition.execute(input, scopedContext));
      raw.then(
        (value) => {
          settle();
          resume(Effect.sync(() => decodeOutput(definition, value)));
        },
        flow(String, (cause) => {
          settle();
          resume(Effect.fail(new ToolBodyFailed({ tool: definition.name, cause })));
        }),
      );
      return Effect.sync(() => controller.abort());
    });
    if (timeoutMs === undefined) return yield* execution;
    const outcome = yield* execution.pipe(Effect.timeoutOption(timeoutMs));
    return Option.getOrElse(outcome, (): ToolBodyOutcome => ({ status: "timed_out" }));
  });
}

function decodeOutput<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
  value: z.output<Out>,
): ToolBodyOutcome {
  const parsed = definition.output.safeParse(value);
  const json = parsed.success ? PlainValueSchema.safeParse(parsed.data) : parsed;
  if (!json.success) {
    return {
      status: "error",
      message: `${definition.name} produced invalid output`,
      errorKind: "invalid_output",
    };
  }
  return { status: "success", output: json.data };
}

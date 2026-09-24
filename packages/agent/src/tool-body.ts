import {
  type PlainValue,
  PlainValueSchema,
  type ToolDefinition,
  type ToolExecutionContext,
} from "@openomni/protocol";
import { Effect, Option } from "effect";
import { z } from "zod";
import { ToolBodyFailed } from "./errors";
import { RawToolSlots } from "./executor-raw";
import { withExecutor, withInvocation, type InvocationFrame } from "./executor-context";
import type { Executor } from "./executor-contract";

export const ToolBodyOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("timed_out") }).strict(),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    errorKind: z.enum(["invalid_input", "precondition_failed", "execution_failed", "invalid_output"]),
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
  executor?: Executor,
  invocation?: InvocationFrame,
): Effect.Effect<ToolBodyOutcome, ToolBodyFailed, RawToolSlots> {
  return Effect.gen(function* () {
    const slots = yield* RawToolSlots;
    const execution = Effect.async<ToolBodyOutcome, ToolBodyFailed>((resume) => {
      const settle = slots.open();
      const controller = new AbortController();
      const scopedContext = {
        ...context,
        signal: AbortSignal.any([context.signal, controller.signal]),
      };
      const enter = () => executor === undefined ? definition.execute(input, scopedContext)
        : withExecutor(executor, () => definition.execute(input, scopedContext));
      const raw = Promise.resolve().then(() => invocation === undefined ? enter() : withInvocation(invocation, enter));
      raw.then(
        (value) => {
          settle();
          resume(Effect.sync(() => decodeOutput(definition, value)));
        },
        (cause: CaughtValue) => {
          settle();
          // An explicit ToolRefused keeps its model-facing classification; every other
          // foreign rejection is a typed body failure the executor records as evidence.
          resume(isToolRefusal(cause)
            ? Effect.succeed<ToolBodyOutcome>({ status: "error", message: cause.message, errorKind: "precondition_failed" })
            : Effect.fail(new ToolBodyFailed({ tool: definition.name, cause: String(cause) })));
        },
      );
      return Effect.sync(() => controller.abort());
    });
    if (timeoutMs === undefined) return yield* execution;
    return yield* execution.pipe(Effect.timeoutOption(timeoutMs), Effect.map((outcome: Option.Option<ToolBodyOutcome>) =>
      Option.getOrElse(outcome, (): ToolBodyOutcome => ({ status: "timed_out" }))));
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

type CaughtValue = PlainValue | Error | bigint | symbol | undefined | ((...args: never[]) => void);

function isToolRefusal(value: CaughtValue): value is Error {
  return value instanceof Error && value.name === "ToolRefused";
}

import {
  PlainValueSchema,
  type PlainValue,
  type ToolDefinition,
  type ToolExecutionContext,
} from "@openomni/protocol";
import { z } from "zod";
import { waveBodyScope } from "./core/execution/tool-wave";

export const ToolBodyOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("timed_out") }).strict(),
  z
    .object({
      status: z.literal("error"),
      message: z.string(),
      errorKind: z.enum(["precondition_failed", "execution_failed", "invalid_output"]),
    })
    .strict(),
  z.object({ status: z.literal("success"), output: PlainValueSchema }).strict(),
]);
type ToolBodyOutcome = z.infer<typeof ToolBodyOutcome>;

export async function executeToolBody<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
  input: z.output<In>,
  context: ToolExecutionContext,
  timeoutMs: number | undefined,
): Promise<ToolBodyOutcome> {
  const outcome = await executeDefinition(definition, input, context, timeoutMs);
  if (outcome.timedOut) return { status: "timed_out" };
  if (outcome.error !== undefined) {
    return {
      status: "error",
      message: outcome.error.message,
      errorKind: isToolRefusal(outcome.error) ? "precondition_failed" : "execution_failed",
    };
  }
  const parsedOutput = definition.output.safeParse(outcome.value);
  const jsonOutput = parsedOutput.success
    ? PlainValueSchema.safeParse(parsedOutput.data)
    : parsedOutput;
  if (!(parsedOutput.success && jsonOutput.success)) {
    return {
      status: "error",
      message: `${definition.name} produced invalid output`,
      errorKind: "invalid_output",
    };
  }
  return { status: "success", output: jsonOutput.data };
}

async function executeDefinition<In extends z.ZodType, Out extends z.ZodType>(
  definition: ToolDefinition<In, Out>,
  input: z.output<In>,
  context: ToolExecutionContext,
  timeoutMs: number | undefined,
): Promise<{
  readonly timedOut: boolean;
  readonly value?: z.output<Out>;
  readonly error?: Error;
}> {
  if (timeoutMs === undefined) {
    return Promise.resolve(definition.execute(input, context)).then(
      (value) => ({ timedOut: false, value }) as const,
      (error) => ({ timedOut: false, error: toError(error) }) as const,
    );
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(context.signal.reason);
  context.signal.addEventListener("abort", forwardAbort, { once: true });
  const scopedContext = { ...context, signal: controller.signal };
  const execution = Promise.resolve(definition.execute(input, scopedContext)).then(
    (value) => ({ timedOut: false, value }) as const,
    (error) => ({ timedOut: false, error: toError(error) }) as const,
  );
  // Retain actual definition settlement, not the caller-facing timeout race.
  // Both fulfillment and rejection above settle this ownership promise normally.
  waveBodyScope.getStore()?.retain?.(execution.then(() => undefined));
  const timeout = Promise.withResolvers<{ readonly timedOut: true }>();
  const timer = setTimeout(() => {
    controller.abort(new Error(`tool timed out after ${timeoutMs}ms`));
    timeout.resolve({ timedOut: true });
  }, timeoutMs);
  return Promise.race([execution, timeout.promise]).finally(() => {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", forwardAbort);
  });
}

function isToolRefusal(error: Error): boolean {
  return error.name === "ToolRefused";
}

type CaughtValue = PlainValue | Error | bigint | symbol | undefined | ((...args: never[]) => void);

function toError(error: CaughtValue): Error {
  return error instanceof Error ? error : new Error(String(error));
}

import { Effect, Result } from "effect";
import { Kernel } from "@openomni/agent";
const ExecutorContext = Kernel.ExecutorContext;
type ExecutorContext = Kernel.ExecutorContext;
type ExecutionError = Kernel.ExecutionError;
type Executor = Kernel.Executor;
import { executor as productionExecutor } from "./executor";
import { runEffect } from "./effect";

/** Run an Effect-native app consumer with the session's attempt authority. */
export async function admittedEffect<T>(
  operation: Effect.Effect<T, ExecutionError>,
  executor: Executor = productionExecutor,
): Promise<T> {
  return Result.getOrThrowWith(
    await runEffect(Effect.result(Effect.provideService(operation, ExecutorContext, executor))),
    (error) => error,
  );
}

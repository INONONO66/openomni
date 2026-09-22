import { Effect, Either } from "effect";
import { ExecutorContext, type ExecutionError, type Executor } from "@openomni/agent";
import { executor as productionExecutor } from "./executor";
import { runEffect } from "./effect";

/** Run an Effect-native app consumer with the session's attempt authority. */
export async function admittedEffect<T>(
  operation: Effect.Effect<T, ExecutionError>,
  executor: Executor = productionExecutor,
): Promise<T> {
  return Either.getOrThrowWith(
    await runEffect(Effect.either(Effect.provideService(operation, ExecutorContext, executor))),
    (error) => error,
  );
}

import { Effect } from "effect";
import { createExecutor } from "../../src/executor";
import type { ResolvedExecutorOptions } from "../../src/executor-contract";
import { executorLayer } from "./service-layers";

/** Acquire an executor with the fixture's services supplied through their Layer. */
export function testExecutor(options: ResolvedExecutorOptions) {
  const { policy, observations, clock, entropy, ...executorOptions } = options;
  return Effect.runSync(
    createExecutor(executorOptions).pipe(
      Effect.provide(executorLayer({ policy, observations, clock, entropy })),
    ),
  );
}

/** Run a synchronous test program after its required services have been provided. */
export function runAgentSync<A, E>(program: Effect.Effect<A, E>): A {
  return Effect.runSync(program);
}

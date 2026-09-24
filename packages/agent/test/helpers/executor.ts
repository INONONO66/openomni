import { Cause, Effect, Exit } from "effect";
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
  return settled(Effect.runSyncExit(program));
}

function settled<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
}

/** Run an asynchronous test program and rethrow its squashed failure cause. */
export async function runAgent<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  return settled(await Effect.runPromiseExit(program));
}

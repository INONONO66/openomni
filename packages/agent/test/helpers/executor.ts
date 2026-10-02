import { Effect } from "effect";
import { createExecutor } from "../../src/kernel/gate/decide";
import type { ResolvedExecutorOptions } from "../../src/kernel/gate/decide";
import { runTestSync } from "./isolated";
import { executorLayer } from "./service-layers";
export { runAgent, runAgentSync } from "./isolated";

/** Acquire an executor with the fixture's services supplied through their Layer. */
export function testExecutor(options: ResolvedExecutorOptions) {
  const { policy, observations, clock, entropy, ...executorOptions } = options;
  return runTestSync(
    createExecutor(executorOptions).pipe(
      Effect.provide(executorLayer({ policy, observations, clock, entropy })),
    ),
  );
}

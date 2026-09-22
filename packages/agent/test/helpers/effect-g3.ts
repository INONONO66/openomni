import { Effect, Cause, Exit } from "effect";

import { runAgent } from "../../src/core/execution/run";
import type { ChatAgentConfig, ChatAgentInput } from "../../src/core/types";
import type { Sink } from "@openomni/llm";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "@openomni/policy";
import type { PolicyRow } from "@openomni/protocol";
import { recordingExecutor } from "./effect-g3-recording";
export { recordingExecutor, recordingLedger } from "./effect-g3-recording";

export function createTestAgent(config: ChatAgentConfig) {
  return { run: (input: ChatAgentInput, sink?: Sink) => {
    const { executor } = recordingExecutor({
      policy: compilePolicySnapshot({ generation: 1, rows: SEEDED_POLICY_ROWS.map((row: Omit<PolicyRow.Row, "generation">) => ({ ...row, generation: 1 })) }),
    });
    return runAgent(input, { executor, execution: executor, ...config }, sink);
  } };
}
export function runTestAgent(input: ChatAgentInput, config: ChatAgentConfig, sink?: Sink) {
  return createTestAgent(config).run(input, sink);
}
export function failure<A, E, R>(program: Effect.Effect<A, E, R> | Promise<A>) {
  if (program instanceof Promise) return Effect.tryPromise({ try: () => program, catch: (error: unknown) => error }).pipe(Effect.flatMap(() => Effect.die("expected a failed Effect")), Effect.catchAll((error: unknown) => Effect.succeed(error)));
  return program.pipe(Effect.exit, Effect.map((exit: Exit.Exit<A, E>): unknown => {
    if (Exit.isSuccess(exit)) throw new Error("expected failed Effect");
    return Cause.squash(exit.cause);
  }));
}

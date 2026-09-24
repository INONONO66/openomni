import { type ChatFixture as ChatAgentConfig, type ChatFixture, chatServices } from "./chat-services";
import { KERNEL_POLICY_REGISTRY } from "@openomni/policy";
import { Effect, Cause, Exit } from "effect";

import { runAgent } from "../../src/core/execution/run";
import type { ChatAgentInput } from "../../src/core/types";
import type { Sink } from "@openomni/llm";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "@openomni/policy";
import type { PolicyRow } from "@openomni/protocol";
import { recordingExecutor } from "./effect-g3-recording";
export { recordingExecutor, recordingLedger } from "./effect-g3-recording";

export function createTestAgent(config: ChatAgentConfig) {
  return { run: (input: ChatAgentInput, sink?: Sink) => {
    const { executor } = recordingExecutor({
      policy: compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY, generation: 1, rows: SEEDED_POLICY_ROWS.map((row: Omit<PolicyRow.Row, "generation">) => ({ ...row, generation: 1 })) }),
    });
    return Effect.gen(function* () { const fixture: ChatFixture = { executor, execution: executor, ...config }; const { events: _events, llm: _llm, ...acquiredConfig } = fixture; return yield* runAgent(input, acquiredConfig, sink).pipe(Effect.provide(chatServices(fixture))); });
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

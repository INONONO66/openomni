import { expect } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { runEffect } from "./effect";

/** Inspect the actual Effect error/defect rather than the runner's FiberFailure wrapper. */
export async function effectFailure<A, E>(program: Effect.Effect<A, E>): Promise<Error> {
  const exit = await runEffect(Effect.exit(program));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) throw new Error("expected Effect failure");
  const failure = Cause.squash(exit.cause);
  if (!(failure instanceof Error)) throw new Error("expected Error failure");
  return failure;
}

import { expect } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { runEffect } from "./effect";

/** Inspect the actual Effect error/defect rather than the runner's FiberFailure wrapper. */
export async function effectFailure<A, E>(program: Effect.Effect<A, E>): Promise<unknown> {
  const exit = await runEffect(Effect.exit(program));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) throw new Error("expected Effect failure");
  return Cause.squash(exit.cause);
}

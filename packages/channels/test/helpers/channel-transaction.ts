import { DecisionFacts } from "@openomni/ledger";
import { Effect, Either } from "effect";
import { decodeChannelFailure, type ChannelError } from "../../src/errors";
import { runEffect } from "./effect";

/** Match the gateway's atomic synchronous admission boundary, including rollback on failure. */
export function channelTransaction<A>(operation: Effect.Effect<A, ChannelError>): Effect.Effect<A, ChannelError> {
  return Effect.try({
    try: () => DecisionFacts.transaction(() => Either.getOrThrowWith(
      runEffect(Effect.either(operation), "sync"),
      (error: ChannelError) => error,
    )),
    catch: decodeChannelFailure("message.transaction"),
  });
}

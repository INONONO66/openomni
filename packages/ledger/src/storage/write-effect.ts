import { Effect } from "effect";
import { ForeignFailure, type LedgerError } from "../errors";

export type RefuseWrite = (error: LedgerError) => never;

/** A refusal must unwind SQLite before it can enter the Effect error channel. */
export function writeEffect<A>(
  operation: string,
  write: (refuse: RefuseWrite) => A,
): Effect.Effect<A, LedgerError> {
  return Effect.suspend(() => {
    let refusal: LedgerError | undefined;
    return Effect.try({
      try: () =>
        write((error) => {
          refusal = error;
          throw error;
        }),
      catch: String,
    }).pipe(Effect.mapError((cause) => refusal ?? new ForeignFailure({ operation, cause })));
  });
}

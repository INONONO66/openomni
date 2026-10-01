import { Cause, Option } from "effect";
import { AgentFailure } from "./errors";

/** The typed error a Cause carries, else `synthesize` applied to the pretty-printed Cause (defects and interrupts). */
export function fromCause<E, F>(cause: Cause.Cause<E>, synthesize: (pretty: string) => F): E | F {
  return Option.getOrElse(Cause.findErrorOption(cause), () => synthesize(Cause.pretty(cause)));
}

/** Agent profile: a Cause without a typed error becomes this package's AgentFailure for `operation`. */
export function of<E>(cause: Cause.Cause<E>, operation: string): E | AgentFailure {
  return fromCause(cause, (pretty) => new AgentFailure({ operation, cause: pretty }));
}

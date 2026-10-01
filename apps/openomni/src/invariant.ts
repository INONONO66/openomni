/**
 * A composition/wiring invariant violation: a state the app promised could
 * not occur. Thrown from plain code (where it surfaces as an Effect defect,
 * never a typed refusal) so callers cannot `catchTag` their way past a bug.
 */
export class AppInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppInvariantError";
  }
}

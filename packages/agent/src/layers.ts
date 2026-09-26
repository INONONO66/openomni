import { Layer, type Context } from "effect";
import { Clock, Entropy, ObservationSink } from "./services";

export interface AgentProcessOptions {
  readonly clock?: () => number;
  readonly entropy?: () => string;
}

/** Pure clock/entropy values and a borrowed root observation port. */
export function AgentProcessLive(observations: Context.Tag.Service<typeof ObservationSink>, options: AgentProcessOptions = {}) {
  return Layer.mergeAll(
    Layer.succeed(Clock, { now: options.clock ?? Date.now }),
    Layer.succeed(Entropy, { next: options.entropy ?? (() => crypto.randomUUID()) }),
    Layer.succeed(ObservationSink, observations),
  );
}

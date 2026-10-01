import { Context, Layer } from "effect";

/** Supplied by the composition root; package code never reads `crypto` or `Math.random` itself. */
export interface EntropySource {
  readonly id: () => string;
  /** Uniform in `[0, 1)`. */
  readonly random: () => number;
}

export class Entropy extends Context.Service<Entropy, EntropySource>()("@openomni/agent/Entropy") {
  static readonly layer = (source: EntropySource): Layer.Layer<Entropy> => Layer.succeed(Entropy, source);
}

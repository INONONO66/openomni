import { Layer, type Context } from "effect";
import { Kernel } from "@openomni/agent";
const Entropy = Kernel.Entropy;
type EntropySource = Kernel.EntropySource;
const ObservationSink = Kernel.ObservationSink;

/** Composition-root-supplied entropy and a borrowed root observation port; time comes from Effect's Clock. */
export function AgentProcessLive(observations: Context.Service.Shape<typeof ObservationSink>, entropy: EntropySource) {
  return Layer.mergeAll(
    Entropy.layer(entropy),
    Layer.succeed(ObservationSink, observations),
  );
}

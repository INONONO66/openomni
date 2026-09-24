import { Layer, type Context } from "effect";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import type { AnyToolDefinition, SessionGeneration } from "@openomni/protocol";
import { Clock, Entropy, ObservationSink, SessionLayer, ToolCatalog } from "./services";

export interface AgentLayerOptions {
  readonly snapshot: SessionGeneration.Snapshot;
  readonly policy: CompiledPolicySnapshot;
  readonly definitions: readonly AnyToolDefinition[];
}

export function AgentGenerationLive(options: AgentLayerOptions) {
  return Layer.mergeAll(
    Layer.succeed(SessionLayer, { snapshot: options.snapshot, policy: options.policy }),
    Layer.succeed(ToolCatalog, { definitions: options.definitions }),
  );
}

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

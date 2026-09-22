import { Layer } from "effect";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import type { AnyToolDefinition, ObservationSink as ObservationPort, SessionGeneration } from "@openomni/protocol";
import { Clock, Entropy, ObservationSink, SessionLayer, ToolCatalog } from "./services";

export interface AgentLayerOptions {
  readonly now: () => number;
  readonly next: () => string;
  readonly observations: ObservationPort;
  readonly snapshot: SessionGeneration.Snapshot;
  readonly policy: CompiledPolicySnapshot;
  readonly definitions: readonly AnyToolDefinition[];
}

export function AgentGenerationLive(options: AgentLayerOptions) {
  return Layer.mergeAll(
    Layer.succeed(Clock, { now: options.now }),
    Layer.succeed(Entropy, { next: options.next }),
    Layer.succeed(ObservationSink, options.observations),
    Layer.succeed(SessionLayer, { snapshot: options.snapshot, policy: options.policy }),
    Layer.succeed(ToolCatalog, { definitions: options.definitions }),
  );
}

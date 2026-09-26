import { Layer } from "effect";
import type { CompiledPolicySnapshot } from "@openomni/policy";
import type { AnyToolDefinition, SessionGeneration } from "@openomni/protocol";
import { SessionLayer, ToolCatalog } from "../../src/services";

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

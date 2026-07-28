import { WorkerBootstrap } from "@openomni/protocol";
import type { AgentDefinition } from "./types";

export namespace RuntimeAgentDefinition {
  // Sole server-to-worker agent egress boundary: protocol parsing projects the
  // worker wire contract and intentionally strips server-only prompt metadata.
  export function create(definition: AgentDefinition): WorkerBootstrap.RuntimeAgentDefinition {
    return WorkerBootstrap.RuntimeAgentDefinition.parse(definition);
  }
}

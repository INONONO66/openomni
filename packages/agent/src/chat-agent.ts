import type { Sink } from "@openomni/protocol";
import type {
  ChatAgentConfig,
  ChatAgentInput,
  AgentResult,
  AgentStep,
} from "./types";

/**
 * ChatAgent instance interface
 */
export interface ChatAgentInstance {
  run(input: ChatAgentInput, sink?: Sink): Promise<AgentResult>;
  stream(input: ChatAgentInput, sink?: Sink): AsyncIterable<AgentStep>;
}

/**
 * ChatAgent namespace — stateless agent for single-turn or multi-turn conversations
 */
export namespace ChatAgent {
  /**
   * Create a new ChatAgent instance
   */
  export function create(config: ChatAgentConfig): ChatAgentInstance {
    return {
      async run(input: ChatAgentInput, sink?: Sink): Promise<AgentResult> {
        throw new Error("not implemented");
      },
      async *stream(
        input: ChatAgentInput,
        sink?: Sink,
      ): AsyncIterable<AgentStep> {
        throw new Error("not implemented");
      },
    };
  }
}

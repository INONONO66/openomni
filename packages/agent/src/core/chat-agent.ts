import type { Sink } from "@openomni/llm";
import type { ChatAgentConfig, ChatAgentInput, AgentResult } from "./types";
import { runAgent } from "./execution/run";

export interface ChatAgentInstance {
  run(input: ChatAgentInput, sink?: Sink): Promise<AgentResult>;
}

export namespace ChatAgent {
  export function create(config: ChatAgentConfig): ChatAgentInstance {
    return {
      run(input: ChatAgentInput, sink?: Sink): Promise<AgentResult> {
        return runAgent(input, config, sink);
      },
    };
  }
}

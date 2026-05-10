import type { Sink } from "@openomni/protocol";
import type { ChatAgentConfig, ChatAgentInput, AgentResult, AgentEvent } from "./types";
import { streamAgent } from "./execution/stream-engine";

export interface ChatAgentInstance {
  run(input: ChatAgentInput, sink?: Sink): Promise<AgentResult>;
  stream(input: ChatAgentInput, sink?: Sink): AsyncIterable<AgentEvent>;
}

export namespace ChatAgent {
  export function create(config: ChatAgentConfig): ChatAgentInstance {
    return {
      async run(input: ChatAgentInput, sink?: Sink): Promise<AgentResult> {
        let result: AgentResult | undefined;
        for await (const event of streamAgent(input, config, sink)) {
          if (event.type === "complete") result = event.result;
          if (event.type === "error" && !event.willRetry) throw event.error;
        }
        if (!result) throw new Error("Agent completed without result");
        return result;
      },
      async *stream(input: ChatAgentInput, sink?: Sink): AsyncIterable<AgentEvent> {
        yield* streamAgent(input, config, sink);
      },
    };
  }
}

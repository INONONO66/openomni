import type { Message, Tool } from "@openomni/protocol";

/**
 * #500 C2: the streaming callback contract of `run()`/the processor, moved
 * here from protocol — llm is the producer side and every consumer (agent,
 * openomni) already depends on llm. The move also retires the name pun with
 * the unrelated `BusEvent.Sink` observation port, which stays in protocol.
 */
export interface Sink {
  onMessage: (message: Message.WithParts) => void;
  /**
   * Executor-boundary tool events: every onToolResult pairs with a
   * preceding onToolCall (the llm processor
   * emits no callback for an unmatched tool-result, #532-6, and settles
   * interruptions as error results), while the internal fold records those
   * anomalies as raw part lifecycle. The agent's trackingSink builds its
   * caller-visible tool call and result notifications from these
   * correlated pairs; deriving them from facts would change the anomaly-path
   * event stream.
   */
  onToolCall: (call: Tool.Call) => void;
  onToolResult: (result: Tool.Result) => void;
}

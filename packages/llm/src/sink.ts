import type { Message, Tool, Transcript } from "@openomni/protocol";

/**
 * #500 C2: the streaming callback contract of `run()`/the processor, moved
 * here from protocol — llm is the producer side and every consumer (agent,
 * openomni) already depends on llm. The move also retires the name pun with
 * the unrelated `BusEvent.Sink` observation port, which stays in protocol.
 */
export interface Sink {
  onMessage: (message: Message.WithParts) => void;
  /**
   * Executor-boundary tool events. These are NOT redundant with onFact:
   * every onToolResult pairs with a preceding onToolCall (the llm processor
   * emits no callback for an unmatched tool-result, #532-6, and settles
   * interruptions as error results), while the fact stream records those
   * anomalies as raw part lifecycle. The agent's trackingSink builds its
   * caller-visible tool call and result notifications from these
   * correlated pairs; deriving them from facts would change the anomaly-path
   * event stream.
   */
  onToolCall: (call: Tool.Call) => void;
  onToolResult: (result: Tool.Result) => void;
  /**
   * Transcript fact stream (#545 T2): every fact the llm processor folds is
   * also offered here, in fold order. Optional because most sinks only want
   * part-boundary snapshots; consumers that need the append-only history
   * (C2/#546 agent history, C3/#547 ledger) subscribe to facts instead of
   * diffing snapshots.
   */
  onFact?: (fact: Transcript.Fact) => void;
}

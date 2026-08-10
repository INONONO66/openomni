import type { Message } from "../message/index.js";
import type { Tool } from "../tool/index.js";
import type { Transcript } from "../transcript/index.js";

export interface Sink {
  onMessage: (message: Message.WithParts) => void;
  /**
   * Executor-boundary tool events. These are NOT redundant with onFact:
   * every onToolResult pairs with a preceding onToolCall (the llm processor
   * emits no callback for an unmatched tool-result, #532-6, and settles
   * interruptions as error results), while the fact stream records those
   * anomalies as raw part lifecycle. The agent's trackingSink builds its
   * public tool_call_start/tool_call_complete AgentEvents from these
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

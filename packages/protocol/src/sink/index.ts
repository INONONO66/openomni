import type { Message } from "../message/index.js";
import type { Tool } from "../tool/index.js";
import type { Run } from "../run/index.js";
import type { Transcript } from "../transcript/index.js";

export interface Sink {
  onMessage: (message: Message.WithParts) => void;
  onToolCall: (call: Tool.Call) => void;
  onToolResult: (result: Tool.Result) => void;
  onSnapshot: (snapshot: Run.Snapshot) => void;
  /**
   * Transcript fact stream (#545 T2): every fact the llm processor folds is
   * also offered here, in fold order. Optional because most sinks only want
   * part-boundary snapshots; consumers that need the append-only history
   * (C2/#546 agent history, C3/#547 ledger) subscribe to facts instead of
   * diffing snapshots.
   */
  onFact?: (fact: Transcript.Fact) => void;
}

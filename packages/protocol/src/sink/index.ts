import type { Message } from "../message/index.js";
import type { Tool } from "../tool/index.js";
import type { Run } from "../run/index.js";

export interface Sink {
  onMessage: (message: Message.WithParts) => void;
  onToolCall: (call: Tool.Call) => void;
  onToolResult: (result: Tool.Result) => void;
  onSnapshot: (snapshot: Run.Snapshot) => void;
}

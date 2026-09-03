// Agent package public API: only surfaces consumed by product composition.
export { ChatAgent } from "./core/chat-agent";
export type { ChatAgentConfig, ChatAgentInput } from "./core/types";
export { RunReasonCode } from "./core/policy/reason-codes";
export { failureFacts } from "./core/retry";
export { placementGatedExecutor } from "./core/execution/turn";
export { createCompactionPolicy } from "./compaction";
export type { CompactionOptions } from "./compaction";

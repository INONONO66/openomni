// Agent package public API — ChatAgent only
export { ChatAgent } from "./core/chat-agent";
export type { ChatAgentInstance } from "./core/chat-agent";
export type { ChatAgentConfig, ChatAgentInput, AgentResult } from "./core/types";
export { PolicyEngine, PolicyRegistry } from "./core/policy";
// Budget accounting stays core (the limits are loop invariants); the queries
// and the types they read and return are exported so a product can decide what
// to say about what is left (D5). Exporting the functions without the types
// leaves a consumer unable to name what it is holding.
export { checkBudget, describeBudgetRemaining } from "./core/budget";
export { RunReasonCode } from "./core/policy/reason-codes";
export type { BudgetState } from "./core/budget";
export type {
  CanonicalPolicyRegistration,
  PolicyContext,
  PolicyEngineRegistration,
  PolicyFn,
  PolicyEngineInstance,
  PolicyRegistryInstance,
} from "./core/policy";
export { McpClient } from "./runtime/mcp/index";
export { createCompactionPolicy } from "./compaction";
export type { CompactionOptions } from "./compaction";

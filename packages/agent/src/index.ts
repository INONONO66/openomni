// Agent package public API — ChatAgent only
export { ChatAgent } from "./core/chat-agent";
export type { ChatAgentInstance } from "./core/chat-agent";
export type { ChatAgentConfig, ChatAgentInput, AgentResult } from "./core/types";
export { PolicyEngine, PolicyRegistry } from "./core/policy";
// Budget accounting stays core (the limits are loop invariants); the queries
// are exported so a product can decide what to say about what is left (D5).
// BudgetState rides along because openomni names it; BudgetStatus does not —
// its consumers hold checkBudget's return structurally, and the entry carries
// only what someone actually imports (#647).
export { checkBudget, describeBudgetRemaining } from "./core/budget";
export { RunReasonCode } from "./core/policy/reason-codes";
export type { BudgetState } from "./core/budget";
export type {
  CanonicalPolicyRegistration,
  PolicyContext,
  PolicyEngineRegistration,
  PolicyFn,
  PolicyEngineInstance,
  PolicyRegistrationFactory,
  PolicyRegistryInstance,
} from "./core/policy";
export { McpClient } from "./runtime/mcp/index";
export { createCompactionPolicy, isTimeCarriageMarkerPart } from "./compaction";
export type { CompactionOptions } from "./compaction";

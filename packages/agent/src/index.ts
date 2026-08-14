// Agent package public API — ChatAgent only
export { ChatAgent } from "./core/chat-agent";
export type { ChatAgentInstance } from "./core/chat-agent";
export type {
  ChatAgentConfig,
  ChatAgentInput,
  AgentResult,
  AgentStep,
  AgentBudget,
  TokenUsage,
  Sink,
} from "./core/types";
export { PolicyEngine, PolicyRegistry, defaultRegistry } from "./core/policy";
// Budget accounting stays core (the limits are loop invariants); the queries
// are exported so a product can decide what to say about what is left (D5).
export { checkBudget, describeBudgetRemaining } from "./core/budget";
export type {
  CanonicalPolicyRegistration,
  PolicyContext,
  PolicyEngineRegistration,
  PolicyFn,
  PolicyRegistration,
  PolicyDecision,
  PolicyAuditConfig,
  PolicyEngineConfig,
  PolicyEngineInstance,
  PolicyFactory,
  PolicyRegistryInstance,
} from "./core/policy";
export { McpClient } from "./runtime/mcp/index";
export type { McpServerConfig } from "./runtime/mcp/index";
export { createCompactionPolicy } from "./core/policy/builtin/compaction";
export { createToolPermissionPolicy } from "./core/policy/builtin/tool-guard";
export { InMemoryCompactor } from "./core/execution/compaction";

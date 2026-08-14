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
export {
  createBudgetReassurancePolicy,
  createBudgetWarningPolicy,
} from "./core/policy/builtin/budget";
export { createCompactionPolicy } from "./core/policy/builtin/compaction";
export { createIdleNudgePolicy } from "./core/policy/builtin/idle-nudge";
export { createToolPermissionPolicy } from "./core/policy/builtin/tool-guard";
export { InMemoryCompactor } from "./core/execution/compaction";

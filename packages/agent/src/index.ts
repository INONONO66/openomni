// Agent package public API: the ChatAgent loop plus the policy-engine and
// budget surfaces a product composes it with.
export { ChatAgent } from "./core/chat-agent";
export type { ChatAgentInstance } from "./core/chat-agent";
export type { ChatAgentConfig, ChatAgentInput, AgentResult } from "./core/types";
export { PolicyEngine } from "./core/policy";
// Budget accounting stays core (the limits are loop invariants); the queries
// are exported so a product can decide what to say about what is left (D5).
// BudgetState rides along because openomni names it; BudgetStatus does not —
// its consumers hold checkBudget's return structurally, and the entry carries
// only what someone actually imports (#647).
export { checkBudget, describeBudgetRemaining } from "./core/budget";
export { RunReasonCode } from "./core/policy/reason-codes";
// The decided terminal facts, for a host that has to explain a failed turn
// to a person. Read-only: the loop is the sole producer.
export { failureFacts } from "./core/retry";
export type { AgentFailureFacts } from "./core/retry";
export type { BudgetState } from "./core/budget";
export type {
  CanonicalPolicyRegistration,
  PolicyContext,
  PolicyEngineRegistration,
  PolicyFn,
  PolicyEngineInstance,
  PolicyRegistrationFactory,
} from "./core/policy";
export { placementGatedExecutor } from "./core/execution/turn";
export { McpClient } from "./runtime/mcp/index";
export {
  createCompactionPolicy,
  isTimeCarriageMarkerPart,
  resolveCompactionGeometry,
} from "./compaction";
export type {
  CompactionGeometry,
  CompactionOptions,
  CompactionYield,
  SummarizationBudget,
} from "./compaction";
export {
  closeSessions,
  session,
  SessionCommitError,
  SessionLeaseError,
  sweepSessions,
} from "./session-handle";
export type {
  SessionBoundaryResult,
  SessionCreateOptions,
  SessionGetOptions,
  SessionHandle,
  SessionRunner,
  SessionRunnerInput,
  SessionRunnerResult,
  SessionRuntime,
  SessionSystem,
  SessionSystemBlocksHandle,
  SessionTool,
  SessionToolsHandle,
} from "./session-handle";

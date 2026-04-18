// Agent package public API — ChatAgent only
export { ChatAgent } from "./core/chat-agent";
export type { ChatAgentInstance } from "./core/chat-agent";
export type {
  ChatAgentConfig,
  ChatAgentInput,
  AgentResult,
  AgentStep,
  AgentEvent,
  AgentBudget,
  TokenUsage,
  Sink,
  StepGuardVerdict,
  StepGuardContext,
  AgentEventEmitter,
  ExecutionHooks,
  HookContext,
  HookVerdict,
} from "./core/types";
export { MiddlewareEngine } from "./core/middleware";
export type {
  MiddlewareContext,
  MiddlewareFn,
  MiddlewareRegistration,
  MiddlewareEngineInstance,
} from "./core/middleware";
export { AgentMessenger, BusTransport } from "./runtime/index";
export type { Transport, AgentMessengerOptions } from "./runtime/index";
export { AgentRegistry } from "./runtime/index";
export { SubagentTool } from "./runtime/index";
export type { SubagentToolOptions } from "./runtime/index";
export { BackgroundOutputTool, BackgroundCancelTool } from "./runtime/index";
export type { BackgroundOutputToolOptions, BackgroundCancelToolOptions } from "./runtime/index";
export { McpClient } from "./runtime/mcp/index";
export type { McpServerConfig } from "./runtime/mcp/index";
export {
  createBudgetReassuranceMiddleware,
  createBudgetWarningMiddleware,
} from "./core/middleware/builtin/budget";
export { createIdleNudgeMiddleware } from "./core/middleware/builtin/idle-nudge";
export { createToolGuardMiddleware } from "./core/middleware/builtin/tool-guard";
export { InMemoryCompactor } from "./core/execution/compaction";

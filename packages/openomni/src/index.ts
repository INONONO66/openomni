// @openomni/openomni — Orchestration package

export * from "./plan/plan-agent.js";
export * from "./plan/hashline.js";
export * from "./plan/plan-store.js";
export * from "./plan/plan-tools.js";
export * from "./plan/structural-gate.js";
export * from "./plan/plan-pipeline.js";
export * from "./team/index.js";
export * from "./dag/index.js";
export * from "./ingress/index.js";
export { FileTaskStore, TaskStorage } from "./legacy/index.js";

export {
  ChatAgent,
  AgentMessenger,
  BusTransport,
  AgentRegistry,
  SubagentTool,
  McpClient,
} from "@openomni/agent";
export type {
  ChatAgentInstance,
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
  Transport,
  AgentMessengerOptions,
  SubagentToolOptions,
  McpServerConfig,
} from "@openomni/agent";

/** @deprecated Legacy orchestration modules — CLI depends on these, do not delete */
export * as _DEPRECATED_legacy from "./legacy/index.js";

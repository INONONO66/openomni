export {
  AgentProfileSchema,
  type AgentProfile,
  AgentIdentitySchema,
  type AgentIdentity,
  AgentCapabilitiesSchema,
  type AgentCapabilities,
  DataScopeSchema,
  type DataScope,
  PolicySpecSchema,
  type PolicySpec,
  AgentStatusSchema,
  type AgentStatus,
  AgentRuntimeSchema,
  type AgentRuntime,
  AgentRegistry,
  createAgentIdentity,
  createAgentRuntime,
} from "./profile";

export {
  NodeKindSchema,
  type NodeKind,
  DeliveryModeSchema,
  type DeliveryMode,
  RouteConditionSchema,
  type RouteCondition,
  AgentNodeSchema,
  type AgentNode,
  AgentEdgeSchema,
  type AgentEdge,
  AgentGraphSpecSchema,
  type AgentGraphSpec,
  GraphValidationError,
  validateEdgeReferences,
  validateNodeReachability,
  validateRouterNodes,
  validateAgentGraph,
} from "./graph";

export namespace Routing {
  export function create() {
    throw new Error("Not implemented");
  }
}

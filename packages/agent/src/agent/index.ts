// Agent domain — identity, registry, discovery, messaging

// From definitions.ts
export {
  AgentProfileSchema,
  type AgentProfile,
  AgentIdentitySchema,
  type AgentIdentity,
  AgentStatusSchema,
  type AgentStatus,
  AgentCapabilitiesSchema,
  type AgentCapabilities,
  DataScopeSchema,
  type DataScope,
  PolicySpecSchema,
  type PolicySpec,
  AgentRuntimeSchema,
  type AgentRuntime,
  createAgentIdentity,
  createAgentRuntime,
} from "./definitions";

// From registry/profile-store.ts
export {
  AgentRegistry,
  InMemoryAgentRegistryStore,
  type AgentRegistryStore,
} from "./registry/profile-store";

// From registry/registry.ts
export {
  BuiltinAgentRegistry,
  AgentDefinitionSchema,
  type AgentDefinition,
} from "./registry/registry";

// From registry/file-registry-storage.ts
export { FileAgentRegistryStore } from "./registry/file-registry-storage";

// From discovery.ts
export {
  parseFrontmatter,
  AgentDiscovery,
  type AgentLoadResult,
  type AgentDiscoveryOptions,
} from "./discovery";

// From communication.ts
export {
  AgentMessenger,
  MessageEnvelope,
  DeliveryOptions,
  MessagingError,
  type AllowPattern,
} from "./communication";

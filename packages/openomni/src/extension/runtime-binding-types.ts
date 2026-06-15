import type { AgentProfile, Extension, McpConfig, Policy, Skill, Tool } from "@openomni/protocol";

type Awaitable<T> = T | Promise<T>;

export interface RuntimeBindingContext {
  readonly extensionId: string;
  readonly version: string;
}

export interface RuntimeBindingExtension {
  readonly id: string;
  readonly version: string;
  readonly contributes?: Extension.Contributes;
}

export interface RuntimeAgentTarget {
  define(definition: AgentProfile.Definition, context: RuntimeBindingContext): Awaitable<void>;
  remove(
    name: string,
    definition: AgentProfile.Definition,
    context: RuntimeBindingContext,
  ): Awaitable<void>;
}

export interface RuntimeToolTarget {
  register(spec: Tool.Spec, context: RuntimeBindingContext): Awaitable<void>;
  unregister(name: string, spec: Tool.Spec, context: RuntimeBindingContext): Awaitable<void>;
}

export interface RuntimeSkillTarget {
  register(definition: Skill.Definition, context: RuntimeBindingContext): Awaitable<void>;
  unregister(
    id: string,
    definition: Skill.Definition,
    context: RuntimeBindingContext,
  ): Awaitable<void>;
}

export interface RuntimeMcpTarget {
  addServer(config: McpConfig.ServerConfig, context: RuntimeBindingContext): Awaitable<void>;
  removeServer(
    name: string,
    config: McpConfig.ServerConfig,
    context: RuntimeBindingContext,
  ): Awaitable<void>;
}

export interface RuntimeSurfaceTarget {
  register(binding: Extension.SurfaceBinding, context: RuntimeBindingContext): Awaitable<void>;
  unregister(
    surfaceId: string,
    binding: Extension.SurfaceBinding,
    context: RuntimeBindingContext,
  ): Awaitable<void>;
}

export interface RuntimeMiddlewareTarget {
  register(definition: Policy.Definition, context: RuntimeBindingContext): Awaitable<void>;
  unregister(
    name: string,
    definition: Policy.Definition,
    context: RuntimeBindingContext,
  ): Awaitable<void>;
}

export interface RuntimeBindingTargets {
  readonly agents?: RuntimeAgentTarget;
  readonly tools?: RuntimeToolTarget;
  readonly skills?: RuntimeSkillTarget;
  readonly mcpServers?: RuntimeMcpTarget;
  readonly surfaces?: RuntimeSurfaceTarget;
  readonly middlewares?: RuntimeMiddlewareTarget;
}

export interface RuntimeBindingController {
  enable(extension: RuntimeBindingExtension): Promise<void>;
  disable(extension: RuntimeBindingExtension): Promise<void>;
}

export interface RegisteredComponent {
  readonly kind: string;
  readonly id: string;
  readonly undo: () => Promise<void>;
}

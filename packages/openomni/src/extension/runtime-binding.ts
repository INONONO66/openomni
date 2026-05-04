import type {
  AgentProfile,
  Extension,
  McpConfig,
  Middleware,
  Skill,
  Tool,
} from "@openomni/protocol";

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
  register(definition: Middleware.Definition, context: RuntimeBindingContext): Awaitable<void>;
  unregister(
    name: string,
    definition: Middleware.Definition,
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

interface RegisteredComponent {
  readonly kind: string;
  readonly id: string;
  readonly undo: () => Promise<void>;
}

export class RuntimeBinding implements RuntimeBindingController {
  private readonly registrations = new Map<string, RegisteredComponent[]>();

  constructor(private readonly targets: RuntimeBindingTargets) {}

  async enable(extension: RuntimeBindingExtension): Promise<void> {
    const key = bindingKey(extension);
    if (this.registrations.has(key)) {
      throw new Error(
        `Extension "${extension.id}" version "${extension.version}" is already bound`,
      );
    }

    const contributes = extension.contributes;
    if (!contributes || !hasContributions(contributes)) {
      return;
    }

    assertTargets(contributes, this.targets);

    const context = { extensionId: extension.id, version: extension.version };
    const registered: RegisteredComponent[] = [];
    this.registrations.set(key, registered);

    try {
      await this.registerAgents(contributes.agents ?? [], context, registered);
      await this.registerTools(contributes.tools ?? [], context, registered);
      await this.registerSkills(contributes.skills ?? [], context, registered);
      await this.registerMcpServers(contributes.mcpServers ?? [], context, registered);
      await this.registerSurfaces(contributes.surfaces ?? [], context, registered);
      await this.registerMiddlewares(contributes.middlewares ?? [], context, registered);
    } catch (error) {
      await this.disable(extension);
      throw new Error(
        `Failed to bind extension "${extension.id}" version "${extension.version}": ${errorMessage(error)}`,
      );
    }
  }

  async disable(extension: RuntimeBindingExtension): Promise<void> {
    const key = bindingKey(extension);
    const registered = this.registrations.get(key);
    if (!registered || registered.length === 0) {
      this.registrations.delete(key);
      return;
    }

    const errors: string[] = [];
    for (let index = registered.length - 1; index >= 0; index -= 1) {
      const component = registered[index];
      if (!component) continue;

      try {
        await component.undo();
        registered.splice(index, 1);
      } catch (error) {
        errors.push(`${component.kind}:${component.id}: ${errorMessage(error)}`);
      }
    }

    if (registered.length === 0) {
      this.registrations.delete(key);
    }
    if (errors.length > 0) {
      throw new Error(
        `Failed to unbind extension "${extension.id}" version "${extension.version}": ${errors.join("; ")}`,
      );
    }
  }

  private async registerAgents(
    definitions: readonly AgentProfile.Definition[],
    context: RuntimeBindingContext,
    registered: RegisteredComponent[],
  ): Promise<void> {
    const target = this.targets.agents;
    if (!target) return;

    for (const definition of definitions) {
      await target.define(definition, context);
      registered.push({
        kind: "agent",
        id: definition.name,
        undo: () => Promise.resolve(target.remove(definition.name, definition, context)),
      });
    }
  }

  private async registerTools(
    specs: readonly Tool.Spec[],
    context: RuntimeBindingContext,
    registered: RegisteredComponent[],
  ): Promise<void> {
    const target = this.targets.tools;
    if (!target) return;

    for (const spec of specs) {
      await target.register(spec, context);
      registered.push({
        kind: "tool",
        id: spec.name,
        undo: () => Promise.resolve(target.unregister(spec.name, spec, context)),
      });
    }
  }

  private async registerSkills(
    definitions: readonly Skill.Definition[],
    context: RuntimeBindingContext,
    registered: RegisteredComponent[],
  ): Promise<void> {
    const target = this.targets.skills;
    if (!target) return;

    for (const definition of definitions) {
      await target.register(definition, context);
      registered.push({
        kind: "skill",
        id: definition.id,
        undo: () => Promise.resolve(target.unregister(definition.id, definition, context)),
      });
    }
  }

  private async registerMcpServers(
    configs: readonly McpConfig.ServerConfig[],
    context: RuntimeBindingContext,
    registered: RegisteredComponent[],
  ): Promise<void> {
    const target = this.targets.mcpServers;
    if (!target) return;

    for (const config of configs) {
      await target.addServer(config, context);
      registered.push({
        kind: "mcpServer",
        id: config.name,
        undo: () => Promise.resolve(target.removeServer(config.name, config, context)),
      });
    }
  }

  private async registerSurfaces(
    bindings: readonly Extension.SurfaceBinding[],
    context: RuntimeBindingContext,
    registered: RegisteredComponent[],
  ): Promise<void> {
    const target = this.targets.surfaces;
    if (!target) return;

    for (const binding of bindings) {
      await target.register(binding, context);
      registered.push({
        kind: "surface",
        id: binding.surfaceId,
        undo: () => Promise.resolve(target.unregister(binding.surfaceId, binding, context)),
      });
    }
  }

  private async registerMiddlewares(
    definitions: readonly Middleware.Definition[],
    context: RuntimeBindingContext,
    registered: RegisteredComponent[],
  ): Promise<void> {
    const target = this.targets.middlewares;
    if (!target) return;

    for (const definition of definitions) {
      await target.register(definition, context);
      registered.push({
        kind: "middleware",
        id: definition.name,
        undo: () => Promise.resolve(target.unregister(definition.name, definition, context)),
      });
    }
  }
}

function assertTargets(
  contributes: Extension.Contributes | undefined,
  targets: RuntimeBindingTargets,
): void {
  const missing = [
    ["agents", contributes?.agents, targets.agents],
    ["tools", contributes?.tools, targets.tools],
    ["skills", contributes?.skills, targets.skills],
    ["mcpServers", contributes?.mcpServers, targets.mcpServers],
    ["surfaces", contributes?.surfaces, targets.surfaces],
    ["middlewares", contributes?.middlewares, targets.middlewares],
  ]
    .filter(
      ([, values, target]) => Array.isArray(values) && values.length > 0 && target === undefined,
    )
    .map(([kind]) => kind);

  if (missing.length > 0) {
    throw new Error(`Missing runtime binding targets for: ${missing.join(", ")}`);
  }
}

function hasContributions(contributes: Extension.Contributes): boolean {
  return (
    (contributes?.agents?.length ?? 0) > 0 ||
    (contributes?.tools?.length ?? 0) > 0 ||
    (contributes?.skills?.length ?? 0) > 0 ||
    (contributes?.mcpServers?.length ?? 0) > 0 ||
    (contributes?.surfaces?.length ?? 0) > 0 ||
    (contributes?.middlewares?.length ?? 0) > 0
  );
}

function bindingKey(extension: RuntimeBindingExtension): string {
  return `${extension.id}@${extension.version}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

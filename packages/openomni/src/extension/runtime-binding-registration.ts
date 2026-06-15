import type { AgentProfile, Extension, McpConfig, Policy, Skill, Tool } from "@openomni/protocol";
import type {
  RegisteredComponent,
  RuntimeBindingContext,
  RuntimeBindingTargets,
} from "./runtime-binding-types";

export async function registerAgents(
  targets: RuntimeBindingTargets,
  definitions: readonly AgentProfile.Definition[],
  context: RuntimeBindingContext,
  registered: RegisteredComponent[],
): Promise<void> {
  const target = targets.agents;
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

export async function registerTools(
  targets: RuntimeBindingTargets,
  specs: readonly Tool.Spec[],
  context: RuntimeBindingContext,
  registered: RegisteredComponent[],
): Promise<void> {
  const target = targets.tools;
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

export async function registerSkills(
  targets: RuntimeBindingTargets,
  definitions: readonly Skill.Definition[],
  context: RuntimeBindingContext,
  registered: RegisteredComponent[],
): Promise<void> {
  const target = targets.skills;
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

export async function registerMcpServers(
  targets: RuntimeBindingTargets,
  configs: readonly McpConfig.ServerConfig[],
  context: RuntimeBindingContext,
  registered: RegisteredComponent[],
): Promise<void> {
  const target = targets.mcpServers;
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

export async function registerSurfaces(
  targets: RuntimeBindingTargets,
  bindings: readonly Extension.SurfaceBinding[],
  context: RuntimeBindingContext,
  registered: RegisteredComponent[],
): Promise<void> {
  const target = targets.surfaces;
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

export async function registerMiddlewares(
  targets: RuntimeBindingTargets,
  definitions: readonly Policy.Definition[],
  context: RuntimeBindingContext,
  registered: RegisteredComponent[],
): Promise<void> {
  const target = targets.middlewares;
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

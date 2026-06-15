import {
  registerAgents,
  registerMcpServers,
  registerMiddlewares,
  registerSkills,
  registerSurfaces,
  registerTools,
} from "./runtime-binding-registration";
import type {
  RegisteredComponent,
  RuntimeBindingController,
  RuntimeBindingExtension,
  RuntimeBindingTargets,
} from "./runtime-binding-types";
import { assertTargets, bindingKey, hasContributions } from "./runtime-binding-validation";

export type {
  RuntimeAgentTarget,
  RuntimeBindingContext,
  RuntimeBindingController,
  RuntimeBindingExtension,
  RuntimeBindingTargets,
  RuntimeMcpTarget,
  RuntimeMiddlewareTarget,
  RuntimeSkillTarget,
  RuntimeSurfaceTarget,
  RuntimeToolTarget,
} from "./runtime-binding-types";

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
      await registerAgents(this.targets, contributes.agents ?? [], context, registered);
      await registerTools(this.targets, contributes.tools ?? [], context, registered);
      await registerSkills(this.targets, contributes.skills ?? [], context, registered);
      await registerMcpServers(this.targets, contributes.mcpServers ?? [], context, registered);
      await registerSurfaces(this.targets, contributes.surfaces ?? [], context, registered);
      await registerMiddlewares(this.targets, contributes.middlewares ?? [], context, registered);
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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

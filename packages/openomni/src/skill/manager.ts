import { type Policy, Skill } from "@openomni/protocol";
import {
  type AuditState,
  approveOperation,
  beginOperation,
  blockOperation,
  operationInput,
} from "./manager-audit";
import {
  globalManagerEntry,
  readLocalEntries,
  readRegistry,
  removeSkillDirectory,
  upsertRegistryEntry,
  writeRegistry,
  writeSkillDefinition,
} from "./manager-io";
import { resolveGlobalSkillsRoot, resolveLocalSkillsRoot, skillPath } from "./shared";

type SkillAction =
  | "skill.install"
  | "skill.enable"
  | "skill.disable"
  | "skill.uninstall"
  | "skill.list";

const DEFAULT_VERSION = "0.0.0";

export interface SkillManagerRoots {
  readonly projectRoot?: string;
  readonly homeRoot?: string;
  readonly localSkillsRoot?: string;
  readonly globalSkillsRoot?: string;
  readonly registryPath?: string;
}

export interface SkillAuditContext {
  readonly sessionId: string;
}

export interface SkillOperationOptions extends SkillManagerRoots {
  readonly actor: Record<string, unknown>;
  readonly audit: SkillAuditContext;
  readonly permission?: Policy.Permission;
  readonly now?: () => Date;
}

export interface SkillInstallOptions extends SkillOperationOptions {
  readonly version?: string;
  readonly enabled?: boolean;
}

export interface SkillUninstallOptions extends SkillOperationOptions {
  readonly scope?: Skill.Scope;
}

export interface SkillListOptions extends SkillOperationOptions {
  readonly scope?: Skill.Scope;
}

export interface SkillManagerEntry {
  readonly id: string;
  readonly scope: Skill.Scope;
  readonly enabled: boolean;
  readonly path?: string;
  readonly source?: string;
  readonly version?: string;
  readonly installedAt?: number;
}

export namespace SkillManager {
  export async function install(
    definition: Skill.Definition,
    source: string,
    options: SkillInstallOptions,
  ): Promise<SkillManagerEntry> {
    const parsed = Skill.Definition.parse(definition);
    assertSafeSkillId(parsed.id);

    const enabled = options.enabled ?? true;
    const version = options.version ?? DEFAULT_VERSION;
    const operation = await beginOperation(options, {
      action: "skill.install",
      resource: parsed.id,
      input: operationInput({
        id: parsed.id,
        scope: parsed.scope,
        source,
        enabled,
        version,
      }),
    });

    if (parsed.scope === "local") {
      const path = skillPath(resolveLocalSkillsRoot(options), parsed.id);
      await approveOperation(operation, "local skill registration approved");
      await writeSkillDefinition(path, parsed);
      return { id: parsed.id, scope: "local", enabled: true, path, source };
    }

    const registry = await readRegistry(options);
    const existing = registry.find((entry) => entry.id === parsed.id);
    const entry: Skill.RegistryEntry = {
      id: parsed.id,
      version: options.version ?? existing?.version ?? DEFAULT_VERSION,
      installedAt: existing?.installedAt ?? operation.now().getTime(),
      enabled: options.enabled ?? existing?.enabled ?? true,
      ...(source.trim().length > 0 ? { source } : {}),
    };
    const path = skillPath(resolveGlobalSkillsRoot(options), parsed.id);

    await approveOperation(
      operation,
      existing ? "global skill update approved" : "global skill install approved",
    );
    await writeSkillDefinition(path, parsed);
    await writeRegistry(upsertRegistryEntry(registry, entry), options);

    return { ...entry, scope: "global", path };
  }

  export async function enable(
    id: string,
    options: SkillOperationOptions,
  ): Promise<SkillManagerEntry> {
    return updateGlobalRegistryEntry(id, true, "skill.enable", options);
  }

  export async function disable(
    id: string,
    options: SkillOperationOptions,
  ): Promise<SkillManagerEntry> {
    return updateGlobalRegistryEntry(id, false, "skill.disable", options);
  }

  export async function uninstall(
    id: string,
    options: SkillUninstallOptions,
  ): Promise<SkillManagerEntry> {
    assertSafeSkillId(id);
    const scope = options.scope ?? "global";
    const operation = await beginOperation(options, {
      action: "skill.uninstall",
      resource: id,
      input: operationInput({ id, scope }),
    });

    if (scope === "local") {
      const path = skillPath(resolveLocalSkillsRoot(options), id);
      if (!(await Bun.file(path).exists())) {
        await blockOperation(operation, "skill.manager.registry", "skill_not_installed");
        throw new Error(`Skill "${id}" is not installed locally`);
      }

      await approveOperation(operation, "local skill uninstall approved");
      await removeSkillDirectory(path);
      return { id, scope, enabled: false, path };
    }

    const registry = await readRegistry(options);
    const existing = registry.find((entry) => entry.id === id);
    if (!existing) {
      await blockOperation(operation, "skill.manager.registry", "skill_not_installed");
      throw new Error(`Skill "${id}" is not installed globally`);
    }

    const path = skillPath(resolveGlobalSkillsRoot(options), id);
    await approveOperation(operation, "global skill uninstall approved");
    await writeRegistry(
      registry.filter((entry) => entry.id !== id),
      options,
    );
    await removeSkillDirectory(path);

    return { ...existing, scope: "global", enabled: false, path };
  }

  export async function list(options: SkillListOptions): Promise<SkillManagerEntry[]> {
    const scope = options.scope;
    const operation = await beginOperation(options, {
      action: "skill.list",
      resource: scope ?? "all",
      input: operationInput({ scope: scope ?? "all" }),
    });

    const entries: SkillManagerEntry[] = [];
    if (scope === undefined || scope === "global") {
      entries.push(
        ...(await readRegistry(options)).map((entry) => globalManagerEntry(entry, options)),
      );
    }
    if (scope === undefined || scope === "local") {
      entries.push(...(await readLocalEntries(options)));
    }

    await approveOperation(operation, "skill list approved");
    return sortManagerEntries(entries);
  }
}

async function updateGlobalRegistryEntry(
  id: string,
  enabled: boolean,
  action: Extract<SkillAction, "skill.enable" | "skill.disable">,
  options: SkillOperationOptions,
): Promise<SkillManagerEntry> {
  assertSafeSkillId(id);
  const operation = await beginOperation(options, {
    action,
    resource: id,
    input: operationInput({ id, scope: "global", enabled }),
  });
  const registry = await readRegistry(options);
  const existing = registry.find((entry) => entry.id === id);
  if (!existing) {
    await blockOperation(operation, "skill.manager.registry", "skill_not_installed");
    throw new Error(`Skill "${id}" is not installed globally`);
  }

  const next = { ...existing, enabled };
  await approveOperation(
    operation,
    enabled ? "global skill enable approved" : "global skill disable approved",
  );
  await writeRegistry(upsertRegistryEntry(registry, next), options);

  return globalManagerEntry(next, options);
}

function assertSafeSkillId(id: string): void {
  if (id !== "." && id !== ".." && /^[A-Za-z0-9._-]+$/.test(id)) {
    return;
  }
  throw new Error(`Invalid skill id "${id}"`);
}

function sortManagerEntries(entries: readonly SkillManagerEntry[]): SkillManagerEntry[] {
  return [...entries].sort((a, b) => {
    const scopeComparison = a.scope.localeCompare(b.scope);
    return scopeComparison === 0 ? a.id.localeCompare(b.id) : scopeComparison;
  });
}

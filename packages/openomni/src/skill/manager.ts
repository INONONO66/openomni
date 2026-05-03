import { Guardrail, Skill, type ExecutionEvent } from "@openomni/protocol";
import { EventLog, Storage } from "@openomni/session";
import { mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type SkillAction =
  | "skill.install"
  | "skill.enable"
  | "skill.disable"
  | "skill.uninstall"
  | "skill.list";

type AuditVisibility = Extract<ExecutionEvent, { type: "action_approved" }>["visibility"];

interface ErrorWithCode {
  readonly code?: unknown;
}

interface AuditState {
  readonly sessionId: string;
  readonly actor: Record<string, unknown>;
  readonly action: SkillAction;
  readonly resource: string;
  readonly input: Record<string, unknown>;
  readonly parentActionId?: string;
  readonly now: () => Date;
}

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
  readonly permission?: Guardrail.Permission;
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

const SKILL_FILE_NAME = "SKILL.md";
const REGISTRY_FILE_NAME = "installed_skills.json";
const AUDIT_VISIBILITY: AuditVisibility = "internal";
const DEFAULT_VERSION = "0.0.0";
const MAX_AUDIT_TEXT_LENGTH = 256;

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
      await rm(dirname(path), { recursive: true, force: true });
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
    await rm(dirname(path), { recursive: true, force: true });

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

async function beginOperation(
  options: SkillOperationOptions,
  request: {
    readonly action: SkillAction;
    readonly resource: string;
    readonly input: Record<string, unknown>;
  },
): Promise<AuditState> {
  const sessionId = requireAuditSession(options);
  const now = options.now ?? (() => new Date());
  const requested = await appendAuditEvent(
    sessionId,
    "action_requested",
    (base): ExecutionEvent.ActionRequested => ({
      type: "action_requested",
      actor: options.actor,
      action: request.action,
      resource: request.resource,
      input: request.input,
      ...base,
    }),
    now,
  );

  const state: AuditState = {
    sessionId,
    actor: options.actor,
    action: request.action,
    resource: request.resource,
    input: request.input,
    parentActionId: requested.actionId,
    now,
  };
  const result = Guardrail.evaluate(options.permission, {
    action: request.action,
    resource: request.resource,
    input: request.input,
    actor: options.actor,
  });

  await appendPolicyEvent(state, result);
  if (result.action === "abort") {
    await blockOperation(state, result.policyId, result.reason, result.action);
    throw new Error(
      `Skill operation "${request.action}" on "${request.resource}" denied: ${result.reason}`,
    );
  }

  return state;
}

async function appendPolicyEvent(
  state: AuditState,
  result: Guardrail.EvaluationResult,
): Promise<void> {
  await appendAuditEvent(
    state.sessionId,
    "policy_evaluated",
    (base): ExecutionEvent.PolicyEvaluated => ({
      type: "policy_evaluated",
      policyId: result.policyId,
      actor: state.actor,
      action: state.action,
      resource: state.resource,
      verdict: result.action,
      reason: result.reason,
      ...base,
    }),
    state.now,
    state.parentActionId,
  );
}

async function approveOperation(state: AuditState, reason: string): Promise<void> {
  await appendAuditEvent(
    state.sessionId,
    "action_approved",
    (base): ExecutionEvent.ActionApproved => ({
      type: "action_approved",
      policyId: "skill.manager",
      actor: state.actor,
      action: state.action,
      resource: state.resource,
      verdict: "continue",
      reason,
      ...base,
    }),
    state.now,
    state.parentActionId,
  );
}

async function blockOperation(
  state: AuditState,
  policyId: string,
  reason: string,
  verdict: ExecutionEvent.ActionBlocked["verdict"] = "abort",
): Promise<void> {
  await appendAuditEvent(
    state.sessionId,
    "action_blocked",
    (base): ExecutionEvent.ActionBlocked => ({
      type: "action_blocked",
      policyId,
      actor: state.actor,
      action: state.action,
      resource: state.resource,
      verdict,
      reason,
      ...base,
    }),
    state.now,
    state.parentActionId,
  );
}

async function appendAuditEvent<T extends ExecutionEvent>(
  sessionId: string,
  eventType: T["type"],
  event: (base: {
    readonly actionId: string;
    readonly parentActionId?: string;
    readonly visibility: AuditVisibility;
    readonly timestamp: string;
    readonly sequence: number;
  }) => T,
  now: () => Date,
  parentActionId?: string,
): Promise<T> {
  const sequence = await readNextSequence(sessionId);
  const row = event({
    actionId: `${sessionId}:${eventType}:skill:${sequence}`,
    ...(parentActionId !== undefined ? { parentActionId } : {}),
    visibility: AUDIT_VISIBILITY,
    timestamp: now().toISOString(),
    sequence,
  });

  await EventLog.append(sessionId, row);
  return row;
}

async function readNextSequence(sessionId: string): Promise<number> {
  let maxSequence = 0;
  for await (const event of EventLog.replay(sessionId)) {
    maxSequence = Math.max(maxSequence, event.sequence);
  }
  return maxSequence + 1;
}

function requireAuditSession(options: SkillOperationOptions): string {
  const sessionId = options.audit?.sessionId;
  if (!sessionId) {
    throw new Error("SkillManager operations require audit.sessionId");
  }

  const adapter = Storage.get();
  if (!adapter.eventLog) {
    throw new Error("EventLog adapter unavailable for mandatory skill audit");
  }
  if (!adapter.session.get(sessionId)) {
    throw new Error(`Audit session "${sessionId}" not found for skill operation`);
  }

  return sessionId;
}

async function readRegistry(options: SkillManagerRoots): Promise<Skill.RegistryEntry[]> {
  const path = resolveRegistryPath(options);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return [];
  }

  let raw: unknown;
  try {
    raw = await file.json();
  } catch (error) {
    throw new Error(`Failed to read skill registry at ${path}: ${errorMessage(error)}`);
  }

  const parsed = Skill.RegistryEntry.array().safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid skill registry at ${path}: ${parsed.error.message}`);
  }

  return sortRegistryEntries(parsed.data);
}

async function writeRegistry(
  entries: readonly Skill.RegistryEntry[],
  options: SkillManagerRoots,
): Promise<void> {
  const parsed = Skill.RegistryEntry.array().safeParse(entries);
  if (!parsed.success) {
    throw new Error(`Invalid skill registry entries: ${parsed.error.message}`);
  }

  const path = resolveRegistryPath(options);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(sortRegistryEntries(parsed.data), null, 2)}\n`);
}

async function writeSkillDefinition(path: string, definition: Skill.Definition): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, serializeSkillDefinition(definition));
}

function serializeSkillDefinition(definition: Skill.Definition): string {
  const lines = [
    "---",
    `id: ${definition.id}`,
    `name: ${definition.name}`,
    `description: ${definition.description}`,
    `layer: ${definition.layer}`,
  ];

  if (definition.useWhen !== undefined) {
    lines.push(`useWhen: ${definition.useWhen}`);
  }
  if (definition.doNotUseWhen !== undefined) {
    lines.push(`doNotUseWhen: ${definition.doNotUseWhen}`);
  }
  if (definition.finalChecklist !== undefined) {
    lines.push("finalChecklist:");
    for (const item of definition.finalChecklist) {
      lines.push(`  - ${item}`);
    }
  }

  const body = definition.promptFragment.trim() || definition.description;
  return [...lines, "---", "", body, ""].join("\n");
}

function upsertRegistryEntry(
  entries: readonly Skill.RegistryEntry[],
  next: Skill.RegistryEntry,
): Skill.RegistryEntry[] {
  const without = entries.filter((entry) => entry.id !== next.id);
  return sortRegistryEntries([...without, next]);
}

async function readLocalEntries(options: SkillManagerRoots): Promise<SkillManagerEntry[]> {
  const root = resolveLocalSkillsRoot(options);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }

  const skills: SkillManagerEntry[] = [];
  for (const id of entries.sort((a, b) => a.localeCompare(b))) {
    const path = skillPath(root, id);
    if (await Bun.file(path).exists()) {
      skills.push({ id, scope: "local", enabled: true, path });
    }
  }
  return skills;
}

function globalManagerEntry(
  entry: Skill.RegistryEntry,
  options: SkillManagerRoots,
): SkillManagerEntry {
  return {
    ...entry,
    scope: "global",
    path: skillPath(resolveGlobalSkillsRoot(options), entry.id),
  };
}

function operationInput(input: {
  readonly id?: string;
  readonly scope?: Skill.Scope | "all";
  readonly source?: string;
  readonly enabled?: boolean;
  readonly version?: string;
}): Record<string, unknown> {
  return {
    ...(input.id !== undefined ? { id: truncateAuditText(input.id) } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.source !== undefined ? { source: truncateAuditText(input.source) } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.version !== undefined ? { version: truncateAuditText(input.version) } : {}),
  };
}

function truncateAuditText(value: string): string {
  return value.length <= MAX_AUDIT_TEXT_LENGTH ? value : value.slice(0, MAX_AUDIT_TEXT_LENGTH);
}

function assertSafeSkillId(id: string): void {
  if (id !== "." && id !== ".." && /^[A-Za-z0-9._-]+$/.test(id)) {
    return;
  }
  throw new Error(`Invalid skill id "${id}"`);
}

function resolveRegistryPath(options: SkillManagerRoots): string {
  return (
    options.registryPath ?? join(resolveHomeRoot(options.homeRoot), ".openomni", REGISTRY_FILE_NAME)
  );
}

function resolveLocalSkillsRoot(options: SkillManagerRoots): string {
  return (
    options.localSkillsRoot ?? join(options.projectRoot ?? process.cwd(), ".openomni", "skills")
  );
}

function resolveGlobalSkillsRoot(options: SkillManagerRoots): string {
  return options.globalSkillsRoot ?? join(resolveHomeRoot(options.homeRoot), ".openomni", "skills");
}

function resolveHomeRoot(homeRoot: string | undefined): string {
  return homeRoot ?? homedir();
}

function skillPath(root: string, id: string): string {
  return join(root, id, SKILL_FILE_NAME);
}

function sortRegistryEntries(entries: readonly Skill.RegistryEntry[]): Skill.RegistryEntry[] {
  return [...entries].sort((a, b) => a.id.localeCompare(b.id));
}

function sortManagerEntries(entries: readonly SkillManagerEntry[]): SkillManagerEntry[] {
  return [...entries].sort((a, b) => {
    const scopeComparison = a.scope.localeCompare(b.scope);
    return scopeComparison === 0 ? a.id.localeCompare(b.id) : scopeComparison;
  });
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as ErrorWithCode).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

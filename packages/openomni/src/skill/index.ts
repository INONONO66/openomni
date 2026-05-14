import { type RuntimeResource, Skill } from "@openomni/protocol";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export { createSkillActivationMiddleware } from "./activation";
export type { SkillActivationMiddlewareOptions } from "./activation";
export { SkillManager } from "./manager";
export type {
  SkillAuditContext,
  SkillInstallOptions,
  SkillListOptions,
  SkillManagerEntry,
  SkillManagerRoots,
  SkillOperationOptions,
  SkillUninstallOptions,
} from "./manager";

type SkillScope = Skill.Definition["scope"];
type SkillOrigin = "project" | "user" | "global";

interface ErrorWithCode {
  readonly code?: unknown;
}

export interface SkillRegistryOptions {
  readonly homeRoot?: string;
  readonly registryPath?: string;
}

export interface SkillLoaderOptions extends SkillRegistryOptions {
  readonly projectRoot?: string;
  readonly localSkillsRoot?: string;
  readonly globalSkillsRoot?: string;
}

interface SkillMetadata {
  id?: string;
  name?: string;
  description?: string;
  layer?: string;
  useWhen?: string;
  doNotUseWhen?: string;
  finalChecklist?: string[];
  mcpTools?: string[];
  promptFragment?: string;
}

interface SkillMarkdownParts {
  readonly header: string;
  readonly body: string;
}

const SKILL_FILE_NAME = "SKILL.md";

export namespace SkillRegistry {
  export async function read(options: SkillRegistryOptions = {}): Promise<Skill.RegistryEntry[]> {
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

  export async function write(
    entries: readonly Skill.RegistryEntry[],
    options: SkillRegistryOptions = {},
  ): Promise<Skill.RegistryEntry[]> {
    const path = resolveRegistryPath(options);
    const parsed = Skill.RegistryEntry.array().safeParse(entries);
    if (!parsed.success) {
      throw new Error(`Invalid skill registry entries: ${parsed.error.message}`);
    }

    const sorted = sortRegistryEntries(parsed.data);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, `${JSON.stringify(sorted, null, 2)}\n`);

    return sorted;
  }
}

export namespace SkillLoader {
  export async function discoverLocal(
    options: SkillLoaderOptions = {},
  ): Promise<Skill.Definition[]> {
    const root = resolveLocalSkillsRoot(options);
    const skillIds = await readSkillIds(root);
    const skills = await Promise.all(skillIds.map((id) => loadLocal(id, options)));

    return sortSkillDefinitions(skills);
  }

  export async function discoverGlobal(
    options: SkillLoaderOptions = {},
  ): Promise<Skill.Definition[]> {
    const entries = await SkillRegistry.read(options);
    const enabledEntries = entries.filter((entry) => entry.enabled);
    const skills = await Promise.all(enabledEntries.map((entry) => loadGlobal(entry.id, options)));

    return sortSkillDefinitions(skills);
  }

  export async function discover(options: SkillLoaderOptions = {}): Promise<Skill.Definition[]> {
    const [local, global] = await Promise.all([discoverLocal(options), discoverGlobal(options)]);

    return sortSkillDefinitions([...local, ...global]);
  }

  export async function loadLocal(
    id: string,
    options: SkillLoaderOptions = {},
  ): Promise<Skill.Definition> {
    const skillPath = join(resolveLocalSkillsRoot(options), id, SKILL_FILE_NAME);

    return loadSkillDefinition(skillPath, "local", id);
  }

  export async function loadGlobal(
    id: string,
    options: SkillLoaderOptions = {},
  ): Promise<Skill.Definition> {
    const skillPath = join(resolveGlobalSkillsRoot(options), id, SKILL_FILE_NAME);

    return loadSkillDefinition(skillPath, "global", id);
  }
}

async function loadSkillDefinition(
  path: string,
  scope: SkillScope,
  expectedId: string,
): Promise<Skill.Definition> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Skill file not found at ${path}`);
  }

  const text = await file.text();
  const metadata = parseSkillMarkdown(text);
  const parsed = Skill.Definition.safeParse({ ...metadata, scope, path });
  if (!parsed.success) {
    throw new Error(`Invalid skill definition at ${path}: ${parsed.error.message}`);
  }
  if (parsed.data.id !== expectedId) {
    throw new Error(
      `Invalid skill definition at ${path}: metadata id "${parsed.data.id}" does not match directory id "${expectedId}"`,
    );
  }

  return attachRuntimeDescriptors(parsed.data, skillOrigin(scope), metadata.mcpTools ?? []);
}

function parseSkillMarkdown(text: string): SkillMetadata {
  const parts = extractMarkdownParts(text);
  const header = parts.header;
  let metadata: SkillMetadata = {};
  let currentKey: keyof SkillMetadata | undefined;

  for (const rawLine of header.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim().length === 0) {
      continue;
    }

    const listItem = /^\s*-\s+(.+)$/.exec(line);
    if (listItem && isListMetadataKey(currentKey)) {
      metadata = appendSkillMetadataItem(metadata, currentKey, stripQuotes(listItem[1] ?? ""));
      continue;
    }

    const continuation = /^\s+(.+)$/.exec(line);
    if (continuation && currentKey && !isListMetadataKey(currentKey)) {
      const previous = metadata[currentKey];
      const next = stripQuotes(continuation[1] ?? "");
      if (typeof previous === "string") {
        metadata = assignSkillMetadata(metadata, currentKey, `${previous}\n${next}`);
      }
      continue;
    }

    const pair = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (!pair) {
      continue;
    }

    const key = normalizeSkillKey(pair[1] ?? "");
    if (!key) {
      currentKey = undefined;
      continue;
    }

    const value = pair[2] ?? "";
    currentKey = key;
    if (isListMetadataKey(key)) {
      metadata = assignSkillMetadataList(metadata, key, value);
      continue;
    }

    if (value.trim() === "|") {
      metadata = assignSkillMetadata(metadata, key, "");
      continue;
    }

    metadata = assignSkillMetadata(metadata, key, stripQuotes(value));
  }

  if (!metadata.promptFragment?.trim()) {
    const promptFragment = parts.body.trim() || metadata.description;
    if (promptFragment) {
      metadata = { ...metadata, promptFragment };
    }
  }

  return metadata;
}

function assignSkillMetadata(
  metadata: SkillMetadata,
  key: keyof SkillMetadata,
  value: string,
): SkillMetadata {
  switch (key) {
    case "id":
      return { ...metadata, id: value };
    case "name":
      return { ...metadata, name: value };
    case "description":
      return { ...metadata, description: value };
    case "layer":
      return { ...metadata, layer: value };
    case "useWhen":
      return { ...metadata, useWhen: value };
    case "doNotUseWhen":
      return { ...metadata, doNotUseWhen: value };
    case "finalChecklist":
      return { ...metadata, finalChecklist: [value] };
    case "mcpTools":
      return { ...metadata, mcpTools: [value] };
    case "promptFragment":
      return { ...metadata, promptFragment: value };
  }
}

function isListMetadataKey(
  key: keyof SkillMetadata | undefined,
): key is "finalChecklist" | "mcpTools" {
  return key === "finalChecklist" || key === "mcpTools";
}

function assignSkillMetadataList(
  metadata: SkillMetadata,
  key: "finalChecklist" | "mcpTools",
  value: string,
): SkillMetadata {
  const item = stripQuotes(value);
  return item.length === 0
    ? { ...metadata, [key]: [] }
    : appendSkillMetadataItem(metadata, key, item);
}

function appendSkillMetadataItem(
  metadata: SkillMetadata,
  key: "finalChecklist" | "mcpTools",
  value: string,
): SkillMetadata {
  if (key === "finalChecklist") {
    return { ...metadata, finalChecklist: [...(metadata.finalChecklist ?? []), value] };
  }
  return { ...metadata, mcpTools: [...(metadata.mcpTools ?? []), value] };
}

function extractMarkdownParts(text: string): SkillMarkdownParts {
  if (text.startsWith("---\n") || text.startsWith("---\r\n")) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (match) {
      return { header: match[1] ?? "", body: text.slice(match[0].length) };
    }
  }

  const lines: string[] = [];
  const allLines = text.split("\n");
  let bodyStart = allLines.length;
  for (const [index, line] of allLines.entries()) {
    if (line.trim().length === 0) {
      bodyStart = index + 1;
      break;
    }
    lines.push(line);
  }

  return { header: lines.join("\n"), body: allLines.slice(bodyStart).join("\n") };
}

function normalizeSkillKey(key: string): keyof SkillMetadata | undefined {
  switch (key) {
    case "id":
    case "name":
    case "description":
    case "layer":
    case "useWhen":
    case "doNotUseWhen":
    case "finalChecklist":
    case "mcpTools":
    case "promptFragment":
      return key;
    default:
      return undefined;
  }
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

async function readSkillIds(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }

  const ids: string[] = [];
  for (const entry of entries) {
    const skillFile = Bun.file(join(root, entry, SKILL_FILE_NAME));
    if (await skillFile.exists()) {
      ids.push(entry);
    }
  }

  return ids.sort((a, b) => a.localeCompare(b));
}

function resolveRegistryPath(options: SkillRegistryOptions): string {
  return (
    options.registryPath ??
    join(resolveHomeRoot(options.homeRoot), ".openomni", "installed_skills.json")
  );
}

function resolveLocalSkillsRoot(options: SkillLoaderOptions): string {
  return (
    options.localSkillsRoot ?? join(options.projectRoot ?? process.cwd(), ".openomni", "skills")
  );
}

function resolveGlobalSkillsRoot(options: SkillLoaderOptions): string {
  return options.globalSkillsRoot ?? join(resolveHomeRoot(options.homeRoot), ".openomni", "skills");
}

function resolveHomeRoot(homeRoot: string | undefined): string {
  return homeRoot ?? homedir();
}

function sortRegistryEntries(entries: readonly Skill.RegistryEntry[]): Skill.RegistryEntry[] {
  return [...entries].sort((a, b) => a.id.localeCompare(b.id));
}

function sortSkillDefinitions(skills: readonly Skill.Definition[]): Skill.Definition[] {
  return [...skills].sort((a, b) => {
    const scopeOrder = a.scope.localeCompare(b.scope);
    return scopeOrder === 0 ? a.id.localeCompare(b.id) : scopeOrder;
  });
}

function attachRuntimeDescriptors(
  definition: Skill.Definition,
  origin: SkillOrigin,
  mcpTools: readonly string[],
): Skill.Definition {
  Object.defineProperties(definition, {
    descriptor: {
      value: createSkillDescriptor(definition, origin),
      enumerable: false,
    },
    mcpToolDescriptors: {
      value: mcpTools.map((toolName) => createSkillMcpToolDescriptor(definition.id, toolName)),
      enumerable: false,
    },
  });

  return definition;
}

function createSkillDescriptor(
  definition: Skill.Definition,
  origin: SkillOrigin,
): RuntimeResource.Descriptor {
  return {
    id: `skill:${definition.id}`,
    kind: "skill",
    labels: [`source.${origin}`, `skill.layer.${definition.layer}`],
    capabilities: ["behavior.inject"],
    effects: ["prompt.modify"],
    source: skillDescriptorSource(origin, definition),
  };
}

function skillDescriptorSource(
  origin: SkillOrigin,
  definition: Skill.Definition,
): RuntimeResource.Source {
  switch (origin) {
    case "project":
      return { type: "project", path: definition.path };
    case "user":
      return { type: "user" };
    case "global":
      return { type: "global", scope: "skill" };
  }
}

function createSkillMcpToolDescriptor(
  skillId: string,
  toolName: string,
): RuntimeResource.Descriptor {
  return {
    id: `tool:skill-mcp:${toolName.split(":").join("/")}`,
    kind: "tool",
    labels: ["source.skill-mcp", `skill.${skillId}`],
    capabilities: ["tool.invoke"],
    effects: ["external.read"],
    source: {
      type: "skill-mcp",
      skillId,
      remoteName: toolName,
    },
  };
}

function skillOrigin(scope: SkillScope): SkillOrigin {
  return scope === "local" ? "project" : "global";
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as ErrorWithCode).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

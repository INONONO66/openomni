import { Skill } from "@openomni/protocol";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { attachRuntimeDescriptors } from "./descriptors";
import { parseSkillMarkdown } from "./markdown";
import { SkillRegistry } from "./registry";
import {
  assertSafeSkillId,
  isEnoent,
  resolveGlobalSkillsRoot,
  resolveLocalSkillsRoot,
  skillOrigin,
  sortSkillDefinitions,
  SKILL_FILE_NAME,
  type SkillLoaderOptions,
  type SkillScope,
} from "./shared";

export type { SkillLoaderOptions } from "./shared";

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
    assertSafeSkillId(id);
    const skillPath = join(resolveLocalSkillsRoot(options), id, SKILL_FILE_NAME);

    return loadSkillDefinition(skillPath, "local", id);
  }

  export async function loadGlobal(
    id: string,
    options: SkillLoaderOptions = {},
  ): Promise<Skill.Definition> {
    assertSafeSkillId(id);
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

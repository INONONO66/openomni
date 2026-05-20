import { Skill } from "@openomni/protocol";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { SkillManagerEntry, SkillManagerRoots } from "./manager";
import {
  assertSafeSkillId,
  isEnoent,
  resolveGlobalSkillsRoot,
  resolveLocalSkillsRoot,
  resolveRegistryPath,
  skillPath,
  sortRegistryEntries,
} from "./shared";

export async function writeRegistry(
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

export async function writeSkillDefinition(
  path: string,
  definition: Skill.Definition,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, serializeSkillDefinition(definition));
}

export async function removeSkillDirectory(path: string): Promise<void> {
  await rm(dirname(path), { recursive: true, force: true });
}

export function upsertRegistryEntry(
  entries: readonly Skill.RegistryEntry[],
  next: Skill.RegistryEntry,
): Skill.RegistryEntry[] {
  const without = entries.filter((entry) => entry.id !== next.id);
  return sortRegistryEntries([...without, next]);
}

export async function readLocalEntries(options: SkillManagerRoots): Promise<SkillManagerEntry[]> {
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
    try {
      assertSafeSkillId(id);
    } catch {
      continue;
    }
    const path = skillPath(root, id);
    if (await Bun.file(path).exists()) {
      skills.push({ id, scope: "local", enabled: true, path });
    }
  }
  return skills;
}

export function globalManagerEntry(
  entry: Skill.RegistryEntry,
  options: SkillManagerRoots,
): SkillManagerEntry {
  return {
    ...entry,
    scope: "global",
    path: skillPath(resolveGlobalSkillsRoot(options), entry.id),
  };
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

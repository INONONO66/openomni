import { Skill } from "@openomni/protocol";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  errorMessage,
  resolveRegistryPath,
  sortRegistryEntries,
  type SkillRegistryOptions,
} from "./shared";

export type { SkillRegistryOptions } from "./shared";

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

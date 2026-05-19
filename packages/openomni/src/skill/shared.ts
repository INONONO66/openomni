import { homedir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@openomni/protocol";

export const SKILL_FILE_NAME = "SKILL.md";
export const REGISTRY_FILE_NAME = "installed_skills.json";

export interface ErrorWithCode {
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

export type SkillScope = Skill.Definition["scope"];
export type SkillOrigin = "project" | "user" | "global";

export function resolveRegistryPath(options: SkillRegistryOptions): string {
  return (
    options.registryPath ?? join(resolveHomeRoot(options.homeRoot), ".openomni", REGISTRY_FILE_NAME)
  );
}

export function resolveLocalSkillsRoot(options: SkillLoaderOptions): string {
  return (
    options.localSkillsRoot ?? join(options.projectRoot ?? process.cwd(), ".openomni", "skills")
  );
}

export function resolveGlobalSkillsRoot(options: SkillLoaderOptions): string {
  return options.globalSkillsRoot ?? join(resolveHomeRoot(options.homeRoot), ".openomni", "skills");
}

export function resolveHomeRoot(homeRoot: string | undefined): string {
  return homeRoot ?? homedir();
}

export function skillPath(root: string, id: string): string {
  return join(root, id, SKILL_FILE_NAME);
}

export function sortRegistryEntries(
  entries: readonly Skill.RegistryEntry[],
): Skill.RegistryEntry[] {
  return [...entries].sort((a, b) => a.id.localeCompare(b.id));
}

export function sortSkillDefinitions(skills: readonly Skill.Definition[]): Skill.Definition[] {
  return [...skills].sort((a, b) => {
    const scopeOrder = a.scope.localeCompare(b.scope);
    return scopeOrder === 0 ? a.id.localeCompare(b.id) : scopeOrder;
  });
}

export function skillOrigin(scope: SkillScope): SkillOrigin {
  return scope === "local" ? "project" : "global";
}

export function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as ErrorWithCode).code === "ENOENT";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { Log } from "@openomni/session";
import { findUp } from "./find-up";

const MAX_SKILLS = 200;

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

function loadSkillsFromDir(skillsDir: string): SkillMeta[] {
  if (!existsSync(skillsDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(skillsDir).sort();
  } catch {
    return [];
  }

  const skills: SkillMeta[] = [];

  for (const entry of entries) {
    const skillDir = join(skillsDir, entry);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    let name = entry;
    let description = "";

    try {
      const content = readFileSync(skillFile, "utf-8");
      const { data } = matter(content);
      if (typeof data.name === "string" && data.name) name = data.name;
      if (typeof data.description === "string") description = data.description;
    } catch {
      // gray-matter parse failure or unreadable file — fall back to directory name
      Log.warn("failed to parse skill file, using directory name as fallback", { skillFile });
    }

    skills.push({ name, description, path: skillFile });
  }

  return skills;
}

const discoverCache = new Map<string, SkillMeta[]>();

export namespace SkillLoader {
  export function discover(workspaceRoot: string, globalConfigDir?: string): SkillMeta[] {
    const key = `${workspaceRoot}\0${globalConfigDir ?? ""}`;
    const cached = discoverCache.get(key);
    if (cached) return cached;

    const projectOpenomniDir = findUp(".openomni", workspaceRoot);
    const projectSkills = projectOpenomniDir
      ? loadSkillsFromDir(join(projectOpenomniDir, "skills"))
      : [];

    const globalRoot = globalConfigDir ?? join(homedir(), ".openomni");
    const globalSkills = loadSkillsFromDir(join(globalRoot, "skills"));

    const seen = new Set<string>(projectSkills.map((s) => s.name));
    const merged = [...projectSkills];

    for (const skill of globalSkills) {
      if (!seen.has(skill.name)) {
        merged.push(skill);
        seen.add(skill.name);
      }
    }

    const result = merged.slice(0, MAX_SKILLS);
    discoverCache.set(key, result);
    return result;
  }

  export function format(skills: SkillMeta[]): string {
    if (skills.length === 0) return "";

    const lines = ["## Available Skills", ""];
    for (const skill of skills) {
      lines.push(`- **${skill.name}**: ${skill.description}`);
    }
    lines.push("");

    return lines.join("\n");
  }

  export function _resetCache(): void {
    discoverCache.clear();
  }
}
